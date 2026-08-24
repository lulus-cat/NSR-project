/**
 * ASR 후처리 교정.
 *
 * 설계 원칙 - **전사본은 증거다.**
 * ------------------------------------------------------------------
 * 이 전사본은 학습자료이면서 동시에 태움 판단의 근거이고, 필요하면 신고 자료가 된다.
 * 그러므로 "읽기 좋게 다듬는 것"과 "말한 내용을 바꾸는 것"을 엄격히 구분한다.
 *
 *   교정한다   : 음성인식이 틀린 것    ("카데타" → "카테터", "노디" → "노티")
 *   교정 안 한다: 화자가 실제로 그렇게 말한 것 ("폴리"를 "유치도뇨관"으로 바꾸지 않는다)
 *
 * 후자는 교정 대신 **주석(annotation)** 을 단다. 화면에서는 밑줄이 그어지고
 * 탭하면 뜻이 뜨며, 학습카드의 씨앗이 된다. 본문은 화자가 말한 그대로 남는다.
 *
 * 원문(`rawText`)은 어떤 경우에도 보존되며, 모든 교정은 개별 수락/거절이 가능하다.
 */

import type { Lexicon, LexiconEntry } from "../lexicon/index.js";
import { defaultLexicon, spokenSurfacesOf } from "../lexicon/index.js";
import { phoneticSimilarity } from "../hangul/similarity.js";
import { expandInitialism } from "../hangul/initialism.js";
import type { CorrectionResult, Edit, TermAnnotation } from "./types.js";
import type { CorrectionMemory } from "./learn.js";
import { lookupLearned } from "./learn.js";

export interface CorrectionOptions {
  lexicon?: Lexicon;
  /**
   * 한글로 읽은 영문 약어를 어떻게 쓸 것인가.
   *   "latin" : "브이에스" → "V/S"   (읽기 쉬움. 기본값)
   *   "keep"  : 원문 유지, 주석만 단다 (말한 그대로가 중요할 때)
   */
  abbreviationStyle?: "latin" | "keep";
  /** 발음 매칭으로 교정을 허용할 최소 신뢰도. 기본 0.9. */
  minPhoneticConfidence?: number;
  /** 한 용어가 걸칠 수 있는 최대 어절 수. 기본 3. */
  maxWordSpan?: number;
  /** 사용자 교정 이력. 있으면 사전보다 먼저 적용한다. */
  memory?: CorrectionMemory;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  for (const m of text.matchAll(re)) {
    tokens.push({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return tokens;
}

/** 후보 문자열 양끝의 문장부호를 떼어낸다. 위치 보정을 위해 오프셋도 함께 반환. */
function trimPunctuation(text: string, start: number): { text: string; start: number } {
  let s = 0;
  let e = text.length;
  const punct = /[.,!?~"'()[\]{}·…:;]/;
  while (s < e && punct.test(text[s])) s++;
  while (e > s && punct.test(text[e - 1])) e--;
  return { text: text.slice(s, e), start: start + s };
}

/**
 * 사전 항목의 표기 중 입력과 가장 가까운 **한글** 표기를 고른다.
 * 후보에서 오인식 표기를 뺀다 - 오인식을 다른 오인식으로 바꾸면 안 된다.
 * 한글 발화를 영문 표기로 바꿔버리는 사고도 함께 막는다.
 */
function closestHangulSurface(entry: LexiconEntry, surface: string): string | null {
  const candidates = spokenSurfacesOf(entry).filter((s) => /[가-힣]/.test(s));
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const s = phoneticSimilarity(surface, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

interface Match {
  /** 원문 기준 위치. */
  start: number;
  end: number;
  /** 매칭에 소비한 마지막 토큰 인덱스. */
  lastTokenIndex: number;
  surface: string;
  entry: LexiconEntry;
  via: "exact" | "misheard" | "phonetic" | "initialism";
  confidence: number;
}

function findBestMatch(
  text: string,
  tokens: Token[],
  from: number,
  lexicon: Lexicon,
  opts: Required<Pick<CorrectionOptions, "maxWordSpan" | "minPhoneticConfidence">>,
): Match | null {
  let best: Match | null = null;
  let bestScore = -1;

  const maxSpan = Math.min(opts.maxWordSpan, tokens.length - from);
  for (let span = maxSpan; span >= 1; span--) {
    const lastToken = tokens[from + span - 1];
    const rawStart = tokens[from].start;

    // 마지막 어절의 조사/어미를 0~3음절까지 잘라가며 시도한다.
    // "폴리를" → "폴리", "석션했어요" → "석션" 을 잡기 위함.
    const maxTrim = Math.min(3, Math.max(0, lastToken.text.length - 1));
    for (let trim = 0; trim <= maxTrim; trim++) {
      const rawEnd = lastToken.end - trim;
      if (rawEnd <= rawStart) continue;
      const slice = text.slice(rawStart, rawEnd);
      const trimmed = trimPunctuation(slice, rawStart);
      const candidate = trimmed.text;
      if (candidate.length < 2) continue;

      const hit = lexicon.lookup(candidate, opts.minPhoneticConfidence);
      if (!hit) continue;

      // 발음 매칭은 짧을수록 우연히 걸릴 확률이 높다.
      // 그렇다고 2음절을 통째로 버리면 이 도메인의 핵심 용어(노티·폴리·오더·인계)가
      // 전부 빠진다. 그래서 배제 대신 **짧을수록 높은 신뢰도를 요구**한다.
      if (hit.via === "phonetic" && hit.confidence < 1) {
        const required =
          candidate.length <= 2
            ? Math.max(opts.minPhoneticConfidence, 0.92)
            : opts.minPhoneticConfidence;
        if (hit.confidence < required) continue;
      }

      // 긴 매칭 + 높은 신뢰도를 선호한다.
      const s = hit.confidence * (1 + candidate.length * 0.03);
      if (s > bestScore) {
        bestScore = s;
        best = {
          start: trimmed.start,
          end: trimmed.start + candidate.length,
          lastTokenIndex: from + span - 1,
          surface: candidate,
          entry: hit.entry,
          via: hit.via,
          confidence: hit.confidence,
        };
      }
    }
    // 더 긴 span에서 확실한(exact) 매칭이 나왔으면 짧은 span은 볼 필요 없다.
    if (best && best.confidence === 1 && best.lastTokenIndex >= from + span - 1) break;
  }
  return best;
}

/** 정식 약어 표기. entry.abbr가 있으면 그대로(슬래시 포함 형태 유지). */
function abbreviationOf(entry: LexiconEntry): string | null {
  return entry.abbr && entry.abbr.length > 0 ? entry.abbr : null;
}

/** 이 한글 표기가 해당 약어를 알파벳으로 읽은 것인가. */
function readsAsAbbreviation(surface: string, abbr: string): boolean {
  if (!/[가-힣]/.test(surface)) return false;
  const target = abbr.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (target.length < 2) return false;
  return expandInitialism(surface).includes(target);
}

/** 공백만 다른 두 표기인가. */
function sameIgnoringSpace(a: string, b: string): boolean {
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/**
 * 전사 텍스트 한 덩어리를 교정하고 용어를 주석한다.
 */
export function correctTranscript(
  input: string,
  options: CorrectionOptions = {},
): CorrectionResult {
  const lexicon = options.lexicon ?? defaultLexicon;
  const abbreviationStyle = options.abbreviationStyle ?? "latin";
  const settings = {
    maxWordSpan: options.maxWordSpan ?? 3,
    minPhoneticConfidence: options.minPhoneticConfidence ?? 0.9,
  };

  // 0단계: 사용자가 직접 고쳐온 이력을 먼저 적용한다.
  //         본인 병동 발음/은어는 사전보다 사용자 이력이 정확하다.
  const learned = options.memory
    ? applyLearned(input, options.memory)
    : { text: input, edits: [] as Edit[] };

  const text = learned.text;
  const tokens = tokenize(text);

  let out = "";
  let srcPos = 0;
  const edits: Edit[] = [...learned.edits];
  const annotations: TermAnnotation[] = [];
  const termIds: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const match = findBestMatch(text, tokens, i, lexicon, settings);
    if (!match) {
      i++;
      continue;
    }

    out += text.slice(srcPos, match.start);

    let replacement = match.surface;
    let reason: Edit["reason"] | null = null;

    const abbr = abbreviationOf(match.entry);
    const isAbbrReading =
      abbr !== null && readsAsAbbreviation(match.surface, abbr);

    if (abbreviationStyle === "latin" && abbr && isAbbrReading) {
      // "브이에스" -> "V/S". 발화 내용은 같고 표기만 읽기 쉽게 바꾸는 것이라
      // 원문 훼손이 아니다. edits에 남으므로 되돌릴 수 있다.
      replacement = abbr;
      reason = "initialism";
    } else if (match.via === "misheard" || (match.via === "phonetic" && match.confidence < 1)) {
      // 음성인식이 틀린 것으로 본다. 가장 가까운 한글 표기로 되돌린다.
      const target = closestHangulSurface(match.entry, match.surface);
      // 공백 유무만 다른 경우는 오인식이 아니다. 손대면 띄어쓰기가 깨진다.
      if (target && target !== match.surface && !sameIgnoringSpace(target, match.surface)) {
        replacement = target;
        reason = match.via === "misheard" ? "misheard" : "phonetic";
      }
    }
    // 그 밖의 exact 매칭은 화자가 실제로 그렇게 말한 것이므로 손대지 않는다.

    const annStart = out.length;
    out += replacement;
    const annEnd = out.length;

    if (reason) {
      edits.push({
        start: annStart,
        end: annEnd,
        from: match.surface,
        to: replacement,
        reason,
        entryId: match.entry.id,
        confidence: match.confidence,
      });
    }

    annotations.push({
      start: annStart,
      end: annEnd,
      surface: replacement,
      entryId: match.entry.id,
      via: match.via,
      confidence: match.confidence,
    });
    if (!termIds.includes(match.entry.id)) termIds.push(match.entry.id);

    srcPos = match.end;
    i = match.lastTokenIndex + 1;
  }
  out += text.slice(srcPos);

  return { original: input, text: out, edits, annotations, termIds };
}

/** 사용자 교정 이력을 문자열 치환으로 적용한다. */
function applyLearned(
  input: string,
  memory: CorrectionMemory,
): { text: string; edits: Edit[] } {
  const edits: Edit[] = [];
  let text = input;
  for (const rule of lookupLearned(memory)) {
    if (!rule.from || rule.from === rule.to) continue;
    let idx = text.indexOf(rule.from);
    while (idx >= 0) {
      text = text.slice(0, idx) + rule.to + text.slice(idx + rule.from.length);
      edits.push({
        start: idx,
        end: idx + rule.to.length,
        from: rule.from,
        to: rule.to,
        reason: "learned",
        confidence: Math.min(1, 0.7 + rule.count * 0.05),
      });
      idx = text.indexOf(rule.from, idx + rule.to.length);
    }
  }
  return { text, edits };
}

/**
 * 전사 전체(세그먼트 배열)를 교정한다.
 * 세그먼트별 원문은 유지하고 `text`만 갱신한다.
 */
export function correctSegments<
  T extends { rawText: string; text: string },
>(segments: T[], options: CorrectionOptions = {}): {
  segments: T[];
  results: CorrectionResult[];
} {
  const results: CorrectionResult[] = [];
  const next = segments.map((seg) => {
    const result = correctTranscript(seg.rawText, options);
    results.push(result);
    return { ...seg, text: result.text };
  });
  return { segments: next, results };
}
