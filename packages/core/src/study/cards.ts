/**
 * 근무 전사본에서 학습카드를 만든다.
 *
 * 왜 자기 근무에서 뽑은 카드가 더 나은가
 * ------------------------------------
 * 시중 암기장은 "일반적인 간호"를 다룬다. 그런데 신규가 실제로 막히는 건
 * **오늘 자기 병동에서 나온 그 말**이다. 오늘 인계에서 "엔피오 유지하고 아이오 정확히"를
 * 못 알아들었으면, 내일도 그 말이 나온다. 일반 암기장에는 그 문장이 없다.
 *
 * 그래서 카드의 앞면은 가능하면 **실제 들은 문장**으로 만든다.
 * 기억은 맥락과 함께 붙을 때 훨씬 오래간다(맥락 부호화).
 *
 * 카드 종류
 *   definition  용어 → 뜻
 *   cloze       실제 들은 문장에서 용어를 지운 빈칸 채우기  ← 가장 효과가 큼
 *   pitfall     이 용어에서 신규가 자주 놓치는 지점
 *   formal      은어 → 간호기록에 쓸 공식 표현
 */

import type { Lexicon } from "../lexicon/index.js";
import { defaultLexicon } from "../lexicon/index.js";
import type { TermAnnotation, SpeakerRole } from "../transcription/types.js";
import { sourcesForTerm } from "../sources/registry.js";

export type CardKind = "definition" | "cloze" | "pitfall" | "formal";

export interface Card {
  id: string;
  kind: CardKind;
  front: string;
  back: string;
  entryId: string;
  /** 이 카드가 나온 근무. 나중에 "그날 무슨 상황이었지"로 되짚을 수 있게. */
  shiftId?: string;
  segmentId?: string;
  /** 원문 인용. cloze 카드의 정답 확인 화면에 함께 보여준다. */
  context?: string;
  /** 더 알아볼 공식 출처 id. */
  sourceIds: string[];
  createdAt: number;
}

export interface CardSourceSegment {
  segmentId: string;
  text: string;
  annotations: TermAnnotation[];
  speakerRole?: SpeakerRole;
  startSec: number;
}

export interface GenerateCardsInput {
  shiftId?: string;
  segments: CardSourceSegment[];
  lexicon?: Lexicon;
  /** 이미 충분히 아는 용어 id. 카드를 만들지 않는다. */
  knownEntryIds?: ReadonlySet<string>;
  now: number;
  /** 한 용어당 만들 cloze 카드 수 상한. 기본 2. */
  maxClozePerTerm?: number;
}

/** 문장 경계로 잘라 해당 위치가 포함된 문장을 돌려준다. */
function sentenceAround(text: string, start: number, end: number): string {
  const boundaries = /[.!?？。\n]/;
  let s = start;
  while (s > 0 && !boundaries.test(text[s - 1])) s--;
  let e = end;
  while (e < text.length && !boundaries.test(text[e])) e++;
  if (e < text.length) e++;
  return text.slice(s, e).trim();
}

function cardId(kind: CardKind, entryId: string, salt: string): string {
  return `${kind}:${entryId}${salt ? `:${salt}` : ""}`;
}

/**
 * 근무 전사본에서 카드를 만든다.
 * 같은 id의 카드는 하나만 남으므로 여러 근무의 결과를 합쳐도 안전하다.
 */
export function generateCards(input: GenerateCardsInput): Card[] {
  const lexicon = input.lexicon ?? defaultLexicon;
  const known = input.knownEntryIds ?? new Set<string>();
  const maxCloze = input.maxClozePerTerm ?? 2;
  const cards = new Map<string, Card>();
  const clozeCount = new Map<string, number>();

  for (const segment of input.segments) {
    for (const ann of segment.annotations) {
      const entry = lexicon.get(ann.entryId);
      if (!entry) continue;
      if (known.has(entry.id)) continue;

      const sourceIds = sourcesForTerm(entry).map((s) => s.id);
      const base = {
        entryId: entry.id,
        shiftId: input.shiftId,
        segmentId: segment.segmentId,
        sourceIds,
        createdAt: input.now,
      };

      // 1) 정의 카드
      const defId = cardId("definition", entry.id, "");
      if (!cards.has(defId)) {
        const label = entry.abbr ? `${entry.ko} (${entry.abbr})` : entry.ko;
        cards.set(defId, {
          ...base,
          id: defId,
          kind: "definition",
          front: `${ann.surface}`,
          back: `${label}\n\n${entry.definition}`,
          context: sentenceAround(segment.text, ann.start, ann.end),
        });
      }

      // 2) 빈칸 카드 - 실제 들은 문장
      const sentence = sentenceAround(segment.text, ann.start, ann.end);
      const used = clozeCount.get(entry.id) ?? 0;
      // 문장이 너무 짧으면 맥락 정보가 없어 빈칸 카드의 의미가 없다.
      if (used < maxCloze && sentence.length >= ann.surface.length + 8) {
        const relativeStart = sentence.indexOf(ann.surface);
        if (relativeStart >= 0) {
          const blanked =
            sentence.slice(0, relativeStart) +
            "____" +
            sentence.slice(relativeStart + ann.surface.length);
          const cId = cardId("cloze", entry.id, `${segment.segmentId}@${ann.start}`);
          if (!cards.has(cId)) {
            cards.set(cId, {
              ...base,
              id: cId,
              kind: "cloze",
              front: `빈칸에 들어갈 말은?\n\n"${blanked}"`,
              back: `${ann.surface}\n\n${entry.ko}: ${entry.definition}`,
              context: sentence,
            });
            clozeCount.set(entry.id, used + 1);
          }
        }
      }

      // 3) 주의점 카드
      if (entry.pitfall) {
        const pId = cardId("pitfall", entry.id, "");
        if (!cards.has(pId)) {
          cards.set(pId, {
            ...base,
            id: pId,
            kind: "pitfall",
            front: `${entry.ko}에서 신규가 가장 자주 놓치는 지점은?`,
            back: entry.pitfall,
          });
        }
      }

      // 4) 은어 → 공식 표현 카드
      if (entry.informal && entry.formal) {
        const fId = cardId("formal", entry.id, "");
        if (!cards.has(fId)) {
          cards.set(fId, {
            ...base,
            id: fId,
            kind: "formal",
            front: `"${entry.ko}"를 간호기록에 쓸 때 표준 표현은?`,
            back: `${entry.formal}\n\n대화에서는 통해도 기록은 법적 문서다. 은어를 그대로 적으면 나중에 해석이 갈린다.`,
          });
        }
      }
    }
  }

  return [...cards.values()];
}

/** 카드 종류별 개수. 학습 화면 상단 요약에 쓴다. */
export function countByKind(cards: Card[]): Record<CardKind, number> {
  const out: Record<CardKind, number> = {
    definition: 0,
    cloze: 0,
    pitfall: 0,
    formal: 0,
  };
  for (const c of cards) out[c.kind] += 1;
  return out;
}
