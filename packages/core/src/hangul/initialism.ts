/**
 * 한글로 받아적힌 영문 약어를 되살린다.
 *
 * 병동 대화의 절반은 영문 약어를 한국어 발음으로 읽은 것이다.
 *   "브이에스 체크했어?"   -> V/S (vital sign)
 *   "디엔알 동의서 받았나"  -> DNR
 *   "에이비지에이 나갔어"   -> ABGA
 *   "엔피오 유지하세요"     -> NPO
 * Whisper는 이걸 소리대로 "브이에스"라고 적는다. 틀린 게 아니라 **원래 그렇게 들린다**.
 * 그러므로 ASR 모델을 탓할 게 아니라, 후처리에서 되돌려야 한다.
 *
 * 방법
 * ----
 * 1. 한글 음절열을 알파벳 읽기 사전으로 파싱한다 (최장일치 + 백트래킹).
 *    "에이비지에이" -> 에이|비|지|에이 -> ABGA
 * 2. 읽기가 중의적이므로(씨=C 또는 S, 지=G 또는 Z) 가능한 조합을 모두 만든다.
 * 3. 사전에 실재하는 약어만 남긴다. 이 필터가 없으면 오탐이 폭발한다.
 *    예: "이오"는 EO로 파싱되지만 사전에 없으므로 버려진다.
 */

/** 알파벳 한 글자의 한국어 읽기들. 실제 병원에서 쓰이는 변이형을 포함한다. */
const LETTER_READINGS: Record<string, string[]> = {
  A: ["에이", "에", "아"],
  B: ["비", "삐"],
  C: ["씨", "시"],
  D: ["디", "띠"],
  E: ["이"],
  F: ["에프", "에후"],
  G: ["지"],
  H: ["에이치", "에치", "에이취"],
  I: ["아이"],
  J: ["제이"],
  K: ["케이"],
  L: ["엘"],
  M: ["엠"],
  N: ["엔"],
  O: ["오"],
  P: ["피", "삐"],
  Q: ["큐"],
  R: ["알", "아르", "아"],
  S: ["에스"],
  T: ["티", "티이", "띠"],
  U: ["유"],
  V: ["브이", "뷔", "비"],
  W: ["더블유", "떠블유", "다블유"],
  X: ["엑스"],
  Y: ["와이"],
  Z: ["지", "제트", "지드"],
};

interface Reading {
  hangul: string;
  letter: string;
}

/** 길이 내림차순으로 정렬된 읽기 목록. 최장일치를 먼저 시도하기 위함. */
const READINGS: Reading[] = Object.entries(LETTER_READINGS)
  .flatMap(([letter, forms]) => forms.map((hangul) => ({ hangul, letter })))
  .sort((a, b) => b.hangul.length - a.hangul.length);

const MAX_READING_LEN = READINGS.length > 0 ? READINGS[0].hangul.length : 0;

/** 한 번의 파싱에서 만들어낼 후보 수 상한. 조합 폭발 방지. */
const MAX_CANDIDATES = 48;

/**
 * 한글 음절열을 알파벳 약어 후보들로 변환한다.
 * 전체가 알파벳 읽기로 완전히 소진되는 파싱만 반환한다.
 *
 * @example
 *   expandInitialism("브이에스")     // ["VS", "BS"]  (브이=V, 비=B 중의성)
 *   expandInitialism("디엔알")       // ["DNR"]
 *   expandInitialism("간호사")       // []  (알파벳 읽기로 파싱 불가)
 */
export function expandInitialism(hangul: string): string[] {
  const src = hangul.replace(/[\s.·/-]/g, "");
  if (src.length === 0) return [];

  const results: string[] = [];
  const seen = new Set<string>();

  const walk = (pos: number, acc: string): void => {
    if (results.length >= MAX_CANDIDATES) return;
    if (pos === src.length) {
      // 한 글자짜리 약어는 정보가 없고 오탐만 만든다.
      if (acc.length >= 2 && !seen.has(acc)) {
        seen.add(acc);
        results.push(acc);
      }
      return;
    }
    for (let len = Math.min(MAX_READING_LEN, src.length - pos); len >= 1; len--) {
      const chunk = src.slice(pos, pos + len);
      for (const reading of READINGS) {
        if (reading.hangul.length !== len) continue;
        if (reading.hangul !== chunk) continue;
        walk(pos + len, acc + reading.letter);
      }
    }
  };

  walk(0, "");
  return results;
}

/**
 * 약어 후보 중 사전에 존재하는 것만 남긴다.
 * `known`은 대문자로 정규화된 약어 집합이어야 한다.
 */
export function resolveInitialism(
  hangul: string,
  known: ReadonlySet<string>,
): string | null {
  const candidates = expandInitialism(hangul);
  for (const c of candidates) {
    if (known.has(c)) return c;
  }
  return null;
}

/**
 * 문장에서 "알파벳 읽기로 보이는" 한글 덩어리 후보를 뽑는다.
 * 실제 약어인지 판정은 사전 대조로 한다. 여기서는 위치만 찾는다.
 */
export interface InitialismSpan {
  text: string;
  start: number;
  end: number;
}

const HANGUL_RUN = /[가-힣]+/g;

export function findInitialismSpans(text: string): InitialismSpan[] {
  const spans: InitialismSpan[] = [];
  for (const m of text.matchAll(HANGUL_RUN)) {
    const run = m[0];
    const base = m.index ?? 0;
    // 덩어리 전체와, 그 안의 모든 부분열(길이 2~8)을 후보로 낸다.
    // 예: "브이에스체크" 안의 "브이에스"를 찾아내야 한다.
    const maxLen = Math.min(run.length, 8);
    for (let len = maxLen; len >= 2; len--) {
      for (let i = 0; i + len <= run.length; i++) {
        const sub = run.slice(i, i + len);
        if (expandInitialism(sub).length === 0) continue;
        spans.push({ text: sub, start: base + i, end: base + i + len });
      }
    }
  }
  // 긴 것 우선, 같은 길이면 앞쪽 우선 - 겹치는 후보 중 더 많이 설명하는 쪽을 택하기 위함.
  spans.sort((a, b) => b.text.length - a.text.length || a.start - b.start);
  return spans;
}
