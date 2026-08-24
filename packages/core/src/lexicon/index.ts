import type { LexiconEntry, LexiconHit, TermCategory } from "./types.js";
import { CLINICAL_TERMS } from "./terms-clinical.js";
import { MEDICATION_TERMS } from "./terms-medication.js";
import { SLANG_TERMS } from "./slang.js";
import { pronunciationKey, normalizeForCompare } from "../hangul/phonology.js";
import { rankByPhoneticSimilarity } from "../hangul/similarity.js";
import { resolveInitialism } from "../hangul/initialism.js";
import { ASR_MISHEARD } from "./misheard.js";

export type { LexiconEntry, LexiconHit, TermCategory };
export { CLINICAL_TERMS, MEDICATION_TERMS, SLANG_TERMS };
export { ASR_MISHEARD } from "./misheard.js";

/** 내장 사전 전체. 오인식 표기는 여기서 각 항목에 주입된다. */
export const BUILTIN_TERMS: readonly LexiconEntry[] = [
  ...CLINICAL_TERMS,
  ...MEDICATION_TERMS,
  ...SLANG_TERMS,
].map((entry) => {
  const misheard = ASR_MISHEARD[entry.id];
  return misheard ? { ...entry, misheard } : entry;
});

interface SurfaceRef {
  surface: string;
  entry: LexiconEntry;
}

/**
 * 조회용 인덱스.
 *
 * 세 단계로 찾는다. 앞 단계가 맞으면 뒤는 시도하지 않는다.
 *   1. exact      - 표기가 그대로 일치 (신뢰도 1.0)
 *   2. phonetic   - 발음형이 같거나 자모 편집거리가 가까움 (신뢰도 = 유사도)
 *   3. initialism - 한글 알파벳 읽기를 영문 약어로 되돌렸을 때 사전에 존재 (신뢰도 0.9)
 */
export class Lexicon {
  readonly entries: readonly LexiconEntry[];

  private readonly byId = new Map<string, LexiconEntry>();
  private readonly byAbbr = new Map<string, LexiconEntry>();
  private readonly exact = new Map<string, LexiconEntry>();
  /** 오인식 표기 → 항목. exact보다 먼저 조회한다. */
  private readonly misheard = new Map<string, LexiconEntry>();
  private readonly byPronunciation = new Map<string, LexiconEntry[]>();
  private readonly surfaces: SurfaceRef[] = [];

  constructor(entries: readonly LexiconEntry[]) {
    this.entries = entries;
    for (const entry of entries) {
      if (this.byId.has(entry.id)) {
        throw new Error(`중복된 lexicon id: ${entry.id}`);
      }
      this.byId.set(entry.id, entry);

      if (entry.abbr) {
        // 두 형태로 등록한다.
        //   "V/S" - 표기 그대로 (사용자가 슬래시까지 입력한 경우)
        //   "VS"  - 영숫자만 남긴 형태 (한글 읽기 복원 결과와 대조하기 위함)
        for (const key of abbrKeys(entry.abbr)) {
          if (!this.byAbbr.has(key)) this.byAbbr.set(key, entry);
        }
      }

      for (const surface of entry.misheard ?? []) {
        const norm = normalizeForCompare(surface);
        if (norm && !this.misheard.has(norm)) this.misheard.set(norm, entry);
      }

      for (const surface of surfacesOf(entry)) {
        const norm = normalizeForCompare(surface);
        if (!norm) continue;
        if (!this.exact.has(norm) && !this.misheard.has(norm)) {
          this.exact.set(norm, entry);
        }
        this.surfaces.push({ surface, entry });

        const pk = pronunciationKey(surface);
        if (!pk) continue;
        const bucket = this.byPronunciation.get(pk);
        if (bucket) {
          if (!bucket.includes(entry)) bucket.push(entry);
        } else {
          this.byPronunciation.set(pk, [entry]);
        }
      }
    }
  }

  get(id: string): LexiconEntry | undefined {
    return this.byId.get(id);
  }

  /**
   * 영숫자만 남긴 약어 집합. 한글 알파벳 읽기를 복원한 결과와 대조하는
   * 화이트리스트로 쓴다. 이 필터가 initialism 복원의 오탐을 막는 유일한 장치다.
   */
  get knownAbbreviations(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const key of this.byAbbr.keys()) {
      const alnum = key.replace(/[^A-Z0-9]/g, "");
      if (alnum.length >= 2) out.add(alnum);
    }
    return out;
  }

  /** 표기형 약어("V/S")를 돌려준다. 없으면 null. */
  abbreviationFor(entryId: string): string | null {
    const entry = this.byId.get(entryId);
    return entry?.abbr && entry.abbr.length > 0 ? entry.abbr : null;
  }

  byCategory(category: TermCategory): LexiconEntry[] {
    return this.entries.filter((e) => e.category === category);
  }

  /** 은어(informal) 표제어만. 보고서 문체 교정에 쓴다. */
  get informalEntries(): LexiconEntry[] {
    return this.entries.filter((e) => e.informal && e.formal);
  }

  /**
   * 한 덩어리의 표면형을 사전 항목으로 해석한다.
   * @param minPhonetic 발음 매칭 최소 유사도. 낮출수록 재현율↑ 정밀도↓.
   */
  lookup(surface: string, minPhonetic = 0.82): LexiconHit | null {
    const norm = normalizeForCompare(surface);
    if (!norm) return null;

    // 오인식 표기를 먼저 본다. exact보다 우선해야 "노디"가 교정 대상이 된다.
    const mis = this.misheard.get(norm);
    if (mis) return { entry: mis, surface, via: "misheard", confidence: 1 };

    const exact = this.exact.get(norm);
    if (exact) return { entry: exact, surface, via: "exact", confidence: 1 };

    // 영문 약어를 그대로 말한 경우 (e.g. "DNR")
    const upper = norm.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (upper.length >= 2) {
      const abbrHit = this.byAbbr.get(upper);
      if (abbrHit) return { entry: abbrHit, surface, via: "exact", confidence: 1 };
    }

    const pk = pronunciationKey(surface);
    const sameSound = pk ? this.byPronunciation.get(pk) : undefined;
    if (sameSound && sameSound.length > 0) {
      return { entry: sameSound[0], surface, via: "phonetic", confidence: 0.98 };
    }

    const initial = resolveInitialism(surface, this.knownAbbreviations);
    if (initial) {
      const entry = this.byAbbr.get(initial);
      if (entry) return { entry, surface, via: "initialism", confidence: 0.9 };
    }

    const ranked = rankByPhoneticSimilarity(
      surface,
      this.surfaces,
      (ref) => ref.surface,
      { minScore: minPhonetic, limit: 1 },
    );
    const top = ranked[0];
    if (top) {
      return {
        entry: top.item.entry,
        surface,
        via: "phonetic",
        confidence: top.score,
      };
    }
    return null;
  }

  /** 사용자 검색용. 표기·정의·영문 어디에 걸려도 결과에 넣는다. */
  search(query: string, limit = 20): LexiconEntry[] {
    const q = normalizeForCompare(query);
    if (!q) return [];
    const scored: { entry: LexiconEntry; rank: number }[] = [];
    for (const entry of this.entries) {
      const haystacks = surfacesOf(entry).map(normalizeForCompare);
      let rank = Infinity;
      for (const h of haystacks) {
        if (h === q) rank = Math.min(rank, 0);
        else if (h.startsWith(q)) rank = Math.min(rank, 1);
        else if (h.includes(q)) rank = Math.min(rank, 2);
      }
      if (rank === Infinity && normalizeForCompare(entry.definition).includes(q)) {
        rank = 3;
      }
      if (rank !== Infinity) scored.push({ entry, rank });
    }
    if (scored.length === 0) {
      // 표기로 못 찾으면 발음으로 한 번 더 시도한다 (오타 관용).
      return rankByPhoneticSimilarity(query, this.entries, surfacesOf, {
        minScore: 0.7,
        limit,
      }).map((r) => r.item);
    }
    scored.sort((a, b) => a.rank - b.rank || a.entry.ko.localeCompare(b.entry.ko));
    return scored.slice(0, limit).map((s) => s.entry);
  }
}

/** 약어를 인덱싱할 키들. 표기 그대로와 영숫자만 남긴 형태. */
function abbrKeys(abbr: string): string[] {
  const upper = abbr.toUpperCase();
  const alnum = upper.replace(/[^A-Z0-9]/g, "");
  return alnum && alnum !== upper ? [upper, alnum] : [upper];
}

/** 항목이 가질 수 있는 모든 표면형(오인식 표기 포함). 조회 인덱스용. */
export function surfacesOf(entry: LexiconEntry): string[] {
  const out = [entry.ko, ...entry.aliases, ...(entry.misheard ?? [])];
  if (entry.en) out.push(entry.en);
  if (entry.abbr) out.push(entry.abbr);
  return out.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * 사람이 실제로 말하는 표기만. 교정의 **목적지**로 쓴다.
 * 오인식 표기를 다른 오인식 표기로 바꾸는 사고를 막는다.
 */
export function spokenSurfacesOf(entry: LexiconEntry): string[] {
  const out = [entry.ko, ...entry.aliases];
  if (entry.en) out.push(entry.en);
  if (entry.abbr) out.push(entry.abbr);
  return out.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * 사전을 만든다. 사용자 정의 항목이 내장 항목보다 우선하도록 앞에 둔다.
 * (병동마다 은어가 다르므로 사용자가 덮어쓸 수 있어야 한다.)
 */
export function buildLexicon(userTerms: readonly LexiconEntry[] = []): Lexicon {
  const seen = new Set(userTerms.map((t) => t.id));
  const merged = [
    ...userTerms,
    ...BUILTIN_TERMS.filter((t) => !seen.has(t.id)),
  ];
  return new Lexicon(merged);
}

/** 기본 사전 (사용자 항목 없음). 테스트와 간단한 조회에 쓴다. */
export const defaultLexicon = buildLexicon();
