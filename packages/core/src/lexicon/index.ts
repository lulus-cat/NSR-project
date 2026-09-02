import type { LexiconEntry, LexiconHit, TermCategory } from "./types.js";
import { CLINICAL_TERMS } from "./terms-clinical.js";
import { MEDICATION_TERMS } from "./terms-medication.js";
import { SLANG_TERMS } from "./slang.js";
import { SLANG_EXTRA_TERMS } from "./slang-extra.js";
import { SPECIMEN_TERMS } from "./slang-specimen.js";
import { OR_TERMS, LTC_TERMS, OR_LTC_TERMS } from "./terms-or-ltc.js";
import { mergeWardPacks, type WardPack } from "./ward-pack.js";
import { pronunciationKey, normalizeForCompare } from "../hangul/phonology.js";
import {
  bestPrepared,
  prepareCandidate,
  rankByPhoneticSimilarity,
  type PreparedCandidate,
} from "../hangul/similarity.js";
import { resolveInitialism, toHangulReading } from "../hangul/initialism.js";
import { ASR_MISHEARD } from "./misheard.js";
import { ALL_ABBREVS, type AbbrevRow } from "./abbreviations.js";

export type { LexiconEntry, LexiconHit, TermCategory };
export { CLINICAL_TERMS, MEDICATION_TERMS, SLANG_TERMS, SLANG_EXTRA_TERMS, SPECIMEN_TERMS };
export { OR_TERMS, LTC_TERMS, OR_LTC_TERMS };
export * from "./ward-pack.js";
export * from "./pack-privacy.js";
export { ASR_MISHEARD } from "./misheard.js";
export { COMMON_WORDS } from "./common-words.js";
export { ALL_ABBREVS } from "./abbreviations.js";
export type { AbbrevRow } from "./abbreviations.js";

/** 손으로 쓴 항목들. 정의·주의점·출처를 갖춘 것들. */
const CURATED_TERMS: readonly LexiconEntry[] = [
  ...CLINICAL_TERMS,
  ...MEDICATION_TERMS,
  ...SLANG_TERMS,
  ...SLANG_EXTRA_TERMS,
  ...SPECIMEN_TERMS,
  ...OR_LTC_TERMS,
].map((entry) => {
  const misheard = ASR_MISHEARD[entry.id];
  return misheard ? { ...entry, misheard } : entry;
});

/** 약어를 비교용 키로. "V/S" → "VS" */
function abbrKey(abbr: string): string {
  return abbr.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * 약어 한 줄을 사전 항목으로 부풀린다.
 *
 * 한국어 발음형("에이비지에이")을 별칭에 넣는 이유는 **매칭 때문이 아니다.**
 * 매칭은 `expandInitialism`이 반대 방향으로 이미 해낸다.
 * 넣는 진짜 이유는 두 가지다.
 *   - Whisper hotwords 에 한국어 발음형이 들어가야 인식률이 오른다.
 *     한국어 오디오에 "ABGA"라는 소리는 존재하지 않는다.
 *   - 화면에서 "이렇게 읽습니다"를 보여줄 수 있다.
 */
function abbrevToEntry(row: AbbrevRow): LexiconEntry {
  const reading = toHangulReading(row.abbr);
  const entry: LexiconEntry = {
    id: `abbr-${abbrKey(row.abbr).toLowerCase()}`,
    ko: row.ko,
    en: row.en,
    abbr: row.abbr,
    aliases: reading ? [reading] : [],
    category: row.category,
    definition: row.ambiguous
      ? `${row.ko} (${row.en}) — 문맥에 따라 뜻이 갈리는 약어입니다.`
      : `${row.ko} (${row.en})`,
  };
  if (row.note) entry.pitfall = row.note;
  return entry;
}

/**
 * 약어 표에서 만들어진 항목들.
 * 손으로 쓴 항목이 이미 다루는 약어는 건너뛴다 — 그쪽이 정의도 주의점도 충실하다.
 */
const ABBREV_TERMS: readonly LexiconEntry[] = (() => {
  const covered = new Set<string>();
  for (const t of CURATED_TERMS) {
    if (t.abbr) covered.add(abbrKey(t.abbr));
  }
  const out: LexiconEntry[] = [];
  for (const row of ALL_ABBREVS) {
    const key = abbrKey(row.abbr);
    if (!key || covered.has(key)) continue;
    covered.add(key);
    out.push(abbrevToEntry(row));
  }
  return out;
})();

/** 내장 사전 전체. */
export const BUILTIN_TERMS: readonly LexiconEntry[] = [
  ...CURATED_TERMS,
  ...ABBREV_TERMS,
];

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
  /**
   * 퍼지 탐색용 후보. 자모 분해와 자모 다중집합을 **만들 때 한 번만** 계산해 둔다.
   * 사전이 수백~수천 항목이 되면 이 준비 작업의 유무가 속도를 좌우한다.
   */
  private readonly prepared: PreparedCandidate<SurfaceRef>[] = [];
  /**
   * 조회 결과 메모. 교정기는 한 문장에서 같은 후보 문자열을 여러 번 던진다
   * (어절 span × 조사 절단 조합). 같은 질문에 같은 답을 다시 계산할 이유가 없다.
   */
  private readonly memo = new Map<string, LexiconHit | null>();

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
        this.prepared.push(prepareCandidate({ surface, entry }, surface));

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

    const memoKey = `${minPhonetic}|${norm}`;
    const cached = this.memo.get(memoKey);
    if (cached !== undefined) {
      // surface 는 호출부의 원문 그대로여야 위치 계산이 맞는다.
      return cached ? { ...cached, surface } : null;
    }
    const hit = this.lookupUncached(norm, surface, minPhonetic);
    // 상한을 넘으면 통째로 비운다. LRU 를 들일 만큼 값진 캐시는 아니다.
    if (this.memo.size >= 4000) this.memo.clear();
    this.memo.set(memoKey, hit);
    return hit;
  }

  private lookupUncached(
    norm: string,
    surface: string,
    minPhonetic: number,
  ): LexiconHit | null {

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

    const top = bestPrepared(surface, this.prepared, minPhonetic);
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

/** 사전을 이루는 세 층. 자세한 설명은 `ward-pack.ts` 머리말 참고. */
export interface LexiconSources {
  /** 내가 직접 만들거나 고친 용어. 가장 우선한다. */
  userTerms?: readonly LexiconEntry[];
  /** 병동에서 받은 사전들. 뒤에 오는 것이 앞을 덮는다. */
  packs?: readonly WardPack[];
}

/**
 * 사전을 만든다.
 *
 * 우선순위: **내 사전 > 병동 사전 > 내장 사전**
 * 구체적인 쪽이 일반적인 쪽을 이긴다. 같은 id를 쓰면 앞선 층이 뒤를 가린다.
 *
 * 예전 호출부와의 호환을 위해 배열도 그대로 받는다 (그 경우 `userTerms`로 본다).
 */
export function buildLexicon(
  sources: readonly LexiconEntry[] | LexiconSources = [],
): Lexicon {
  const opts: LexiconSources = Array.isArray(sources)
    ? { userTerms: sources as readonly LexiconEntry[] }
    : (sources as LexiconSources);

  const layers: readonly (readonly LexiconEntry[])[] = [
    opts.userTerms ?? [],
    mergeWardPacks(opts.packs ?? []),
    BUILTIN_TERMS,
  ];

  const seen = new Set<string>();
  const merged: LexiconEntry[] = [];
  for (const layer of layers) {
    for (const term of layer) {
      if (seen.has(term.id)) continue;
      seen.add(term.id);
      merged.push(term);
    }
  }
  return new Lexicon(merged);
}

/** 기본 사전 (사용자 항목 없음). 테스트와 간단한 조회에 쓴다. */
export const defaultLexicon = buildLexicon();
