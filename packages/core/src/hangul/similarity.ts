/**
 * 자모 단위 가중 편집거리와 유사도.
 *
 * 일반 편집거리는 모든 치환을 똑같이 1로 센다. 그러나 음성인식 오류는
 * 아무 자모나 무작위로 틀리지 않는다. 실제로 자주 헷갈리는 쌍이 정해져 있다.
 *   ㄷ↔ㅌ↔ㄸ (평음/격음/경음)
 *   ㅐ↔ㅔ    (현대 서울말에서 사실상 합류)
 *   ㅗ↔ㅜ, ㅡ↔ㅓ
 *   ㄴ↔ㅁ↔ㅇ (비음)
 * 이런 쌍의 치환 비용을 낮춰주면 "카데타"와 "카테터"의 거리는 크게 줄고
 * "카데타"와 "간호사"의 거리는 그대로 남는다. 오탐을 늘리지 않고 재현율만 올린다.
 */

import { toJamo } from "./jamo.js";
import { pronounce, normalizeForCompare } from "./phonology.js";

/** 같은 그룹 안의 자모는 서로 혼동되기 쉽다. */
const CONFUSION_GROUPS: string[][] = [
  // 자음 - 조음위치가 같고 발성유형만 다른 계열
  ["ㄱ", "ㄲ", "ㅋ"],
  ["ㄷ", "ㄸ", "ㅌ"],
  ["ㅂ", "ㅃ", "ㅍ"],
  ["ㅈ", "ㅉ", "ㅊ"],
  ["ㅅ", "ㅆ"],
  // 비음/유음
  ["ㄴ", "ㅁ", "ㅇ"],
  ["ㄴ", "ㄹ"],
  // 외래어에서 자주 흔들리는 쌍 (f/p, s/sh)
  ["ㅎ", "ㅍ"],
  ["ㅅ", "ㅊ"],
  // 단모음 - 현대 서울말에서 합류했거나 청취 혼동이 큰 쌍
  ["ㅐ", "ㅔ", "ㅒ", "ㅖ"],
  ["ㅗ", "ㅜ", "ㅓ"],
  ["ㅡ", "ㅓ", "ㅜ"],
  ["ㅣ", "ㅢ"],
  // 이중모음과 대응 단모음
  ["ㅏ", "ㅑ"],
  ["ㅓ", "ㅕ"],
  ["ㅗ", "ㅛ"],
  ["ㅜ", "ㅠ"],
  ["ㅚ", "ㅞ", "ㅙ", "ㅔ", "ㅐ"],
  ["ㅟ", "ㅜ", "ㅢ"],
  ["ㅘ", "ㅏ"],
  ["ㅝ", "ㅓ"],
];

const VOWELS = new Set([
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
  "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
]);

/** 삽입/삭제 비용이 낮은 자모 - 실제로 잘 들리지 않아 누락되기 쉽다. */
const WEAK_JAMO = new Set(["ㅇ", "ㅎ", "ㅡ", "ㅣ"]);

const CONFUSION_COST = new Map<string, number>();
for (const group of CONFUSION_GROUPS) {
  for (const a of group) {
    for (const b of group) {
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      CONFUSION_COST.set(key, 0.3);
    }
  }
}

function substitutionCost(a: string, b: string): number {
  if (a === b) return 0;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const confused = CONFUSION_COST.get(key);
  if (confused !== undefined) return confused;
  const aVowel = VOWELS.has(a);
  const bVowel = VOWELS.has(b);
  if (aVowel !== bVowel) return 1.2; // 모음과 자음이 바뀌면 사실상 다른 단어
  return 0.95;
}

function indelCost(jamo: string): number {
  return WEAK_JAMO.has(jamo) ? 0.5 : 1;
}

/**
 * 자모 배열 간 가중 Damerau-Levenshtein 거리.
 * 인접 전위(transposition)까지 세는 이유는 "카테터" -> "카터테" 같은
 * 음절 순서 뒤집힘이 ASR 출력에서 실제로 나타나기 때문이다.
 */
export function jamoDistance(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.reduce((s, j) => s + indelCost(j), 0);
  if (m === 0) return a.reduce((s, j) => s + indelCost(j), 0);

  // 전위를 세려면 i-2 행이 필요하므로 3행 버퍼를 돌려 쓴다.
  let rowMinus2 = new Float64Array(m + 1);
  let rowMinus1 = new Float64Array(m + 1);
  let row = new Float64Array(m + 1);

  for (let j = 1; j <= m; j++) rowMinus1[j] = rowMinus1[j - 1] + indelCost(b[j - 1]);

  for (let i = 1; i <= n; i++) {
    row[0] = rowMinus1[0] + indelCost(a[i - 1]);
    for (let j = 1; j <= m; j++) {
      const sub = rowMinus1[j - 1] + substitutionCost(a[i - 1], b[j - 1]);
      const del = rowMinus1[j] + indelCost(a[i - 1]);
      const ins = row[j - 1] + indelCost(b[j - 1]);
      let best = sub < del ? sub : del;
      if (ins < best) best = ins;
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const swap = rowMinus2[j - 2] + 0.6;
        if (swap < best) best = swap;
      }
      row[j] = best;
    }
    const spare = rowMinus2;
    rowMinus2 = rowMinus1;
    rowMinus1 = row;
    row = spare;
  }
  return rowMinus1[m];
}

/**
 * 공백/문장부호를 제거한 발음 자모열.
 *
 * 캐시를 두는 이유: 후보 랭킹은 사전의 모든 표기(약 900개)에 대해 매번 호출된다.
 * 사전 표기는 앱이 도는 동안 변하지 않으므로 재계산이 순수 낭비다.
 * 전사 한 건을 교정할 때 이 함수 호출이 수십만 번 발생한다.
 */
const jamoCache = new Map<string, string[]>();
const JAMO_CACHE_LIMIT = 20000;

export function comparableJamo(text: string): string[] {
  const cached = jamoCache.get(text);
  if (cached) return cached;
  const computed = toJamo(pronounce(normalizeForCompare(text))).filter(
    (j) => !/^[\s.,!?~/\\'"()[\]{}-]$/.test(j),
  );
  // 무한 증가 방지. 단순 초기화로 충분하다 - 사전 표기는 곧 다시 채워진다.
  if (jamoCache.size >= JAMO_CACHE_LIMIT) jamoCache.clear();
  jamoCache.set(text, computed);
  return computed;
}

/** 자모 다중집합. 값싼 사전 거르기에 쓴다. */
export function jamoBag(jamo: readonly string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const j of jamo) bag.set(j, (bag.get(j) ?? 0) + 1);
  return bag;
}

/** 두 다중집합의 교집합 크기. */
function bagOverlap(a: Map<string, number>, b: Map<string, number>): number {
  // 작은 쪽을 돌아야 빠르다.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let common = 0;
  for (const [j, n] of small) {
    const m = large.get(j);
    if (m !== undefined) common += n < m ? n : m;
  }
  return common;
}

/**
 * 편집거리를 계산하기 **전에** 이 후보가 가능성이 있는지 값싸게 판정한다.
 *
 * 사전이 커지면 이게 전부를 좌우한다. 항목 2000개 × 표기 4개면 후보가 8000개인데,
 * 그 전부에 대해 자모 DP를 돌리면 문장 한 줄 교정에 수 초가 걸린다.
 * 폰에서는 아예 못 쓴다.
 *
 * 두 가지 하한을 쓴다. 둘 다 **참인 매칭을 절대 버리지 않는** 안전한 경계다.
 *
 *  1. 길이 — 길이가 1 다를 때마다 최소 0.5의 삽입/삭제 비용이 든다.
 *     유사도 ≤ 1 - 0.5·|la-lb|/max  이므로  |la-lb| ≤ 2·max·(1-minScore).
 *
 *  2. 자모 구성 — 겹치지 않는 자모는 하나당 최소 0.3(가장 싼 치환)의 비용이 든다.
 *     유사도 ≤ 1 - 0.3·(max-공통)/max  이므로  공통 ≥ max·(1 - (1-minScore)/0.3).
 */
export function mayReachSimilarity(
  aLen: number,
  bLen: number,
  minScore: number,
  overlap: number,
): boolean {
  const maxLen = aLen > bLen ? aLen : bLen;
  if (maxLen === 0) return true;
  const slack = 1 - minScore;
  if (Math.abs(aLen - bLen) > 2 * maxLen * slack) return false;
  const needed = maxLen * (1 - slack / 0.3);
  return overlap >= needed;
}

/**
 * 두 한국어 문자열의 발음 유사도. 0(무관) ~ 1(동일).
 * 발음형 정규화를 먼저 적용하므로 연음/경음화 표기 차이는 비용 0이 된다.
 */
export function phoneticSimilarity(a: string, b: string): number {
  const ja = comparableJamo(a);
  const jb = comparableJamo(b);
  const maxLen = Math.max(ja.length, jb.length);
  if (maxLen === 0) return 1;
  const dist = jamoDistance(ja, jb);
  return Math.max(0, 1 - dist / maxLen);
}

export interface RankedMatch<T> {
  item: T;
  score: number;
  /** 실제로 매칭된 표제어/별칭. 사용자에게 "무엇과 매칭됐는지" 보여줄 때 쓴다. */
  matchedKey: string;
}

/**
 * 후보 중 발음이 가장 비슷한 것들을 점수 순으로 돌려준다.
 *
 * @param minScore 이 점수 미만은 버린다. 기본 0.72 - 이 아래로 내리면 오탐이 급증한다.
 */
export function rankByPhoneticSimilarity<T>(
  query: string,
  candidates: readonly T[],
  keyOf: (item: T) => string | readonly string[],
  options: { minScore?: number; limit?: number } = {},
): RankedMatch<T>[] {
  const minScore = options.minScore ?? 0.72;
  const limit = options.limit ?? 5;
  const qJamo = comparableJamo(query);
  const qBag = jamoBag(qJamo);
  const out: RankedMatch<T>[] = [];
  for (const item of candidates) {
    const keys = keyOf(item);
    const keyList = typeof keys === "string" ? [keys] : keys;
    let best = 0;
    let bestKey = "";
    for (const k of keyList) {
      const kJamo = comparableJamo(k);
      // 값싼 거르기를 먼저. 여기서 대부분이 떨어진다.
      if (!mayReachSimilarity(qJamo.length, kJamo.length, minScore, bagOverlap(qBag, jamoBag(kJamo)))) {
        continue;
      }
      const maxLen = Math.max(qJamo.length, kJamo.length);
      const s = maxLen === 0 ? 1 : Math.max(0, 1 - jamoDistance(qJamo, kJamo) / maxLen);
      if (s > best) {
        best = s;
        bestKey = k;
      }
      if (best === 1) break;
    }
    if (best >= minScore) out.push({ item, score: best, matchedKey: bestKey });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit);
}

/**
 * 미리 계산해 둔 후보에 대한 최근접 탐색.
 * 사전처럼 후보가 고정된 경우, 자모 분해와 다중집합을 한 번만 만들어 두고 재사용한다.
 */
export interface PreparedCandidate<T> {
  item: T;
  surface: string;
  jamo: string[];
  bag: Map<string, number>;
}

export function prepareCandidate<T>(item: T, surface: string): PreparedCandidate<T> {
  const jamo = comparableJamo(surface);
  return { item, surface, jamo, bag: jamoBag(jamo) };
}

export function bestPrepared<T>(
  query: string,
  candidates: readonly PreparedCandidate<T>[],
  minScore: number,
): RankedMatch<T> | null {
  const qJamo = comparableJamo(query);
  const qBag = jamoBag(qJamo);
  let best: RankedMatch<T> | null = null;
  for (const c of candidates) {
    if (!mayReachSimilarity(qJamo.length, c.jamo.length, minScore, bagOverlap(qBag, c.bag))) {
      continue;
    }
    const maxLen = Math.max(qJamo.length, c.jamo.length);
    const score = maxLen === 0 ? 1 : Math.max(0, 1 - jamoDistance(qJamo, c.jamo) / maxLen);
    if (score >= minScore && (!best || score > best.score)) {
      best = { item: c.item, score, matchedKey: c.surface };
      if (score === 1) break;
    }
  }
  return best;
}
