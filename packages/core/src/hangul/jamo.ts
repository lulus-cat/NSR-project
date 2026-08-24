/**
 * 한글 자모 분해/결합.
 *
 * 한글 음절(U+AC00~U+D7A3)은 다음 식으로 구성된다.
 *   code = 0xAC00 + (초성index * 21 + 중성index) * 28 + 종성index
 *
 * ASR(음성인식) 결과 교정에서 자모 단위 비교가 필요한 이유:
 * 음절 단위로 비교하면 "카테터"와 "카데터"는 완전히 다른 두 글자로 취급되지만,
 * 자모 단위로 보면 ㅌ↔ㄷ 하나만 다르다. 실제 ASR 오류는 대부분 자모 1~2개 수준이다.
 */

export const CHOSEONG = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const;

export const JUNGSEONG = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
  "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
] as const;

/** 인덱스 0은 "받침 없음". */
export const JONGSEONG = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ",
  "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const;

export const SYLLABLE_BASE = 0xac00;
export const SYLLABLE_LAST = 0xd7a3;

export interface Syllable {
  /** 초성 (예: "ㄱ") */
  cho: string;
  /** 중성 (예: "ㅏ") */
  jung: string;
  /** 종성. 받침이 없으면 빈 문자열. */
  jong: string;
}

/** 완성형 한글 음절인지 확인. */
export function isHangulSyllable(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return code >= SYLLABLE_BASE && code <= SYLLABLE_LAST;
}

/** 문자열에 한글 음절이 하나라도 포함되어 있는지. */
export function hasHangul(text: string): boolean {
  for (const ch of text) if (isHangulSyllable(ch)) return true;
  return false;
}

/** 완성형 음절 하나를 초/중/종성으로 분해. 한글이 아니면 null. */
export function splitSyllable(ch: string): Syllable | null {
  if (!isHangulSyllable(ch)) return null;
  const offset = ch.charCodeAt(0) - SYLLABLE_BASE;
  const jongIndex = offset % 28;
  const jungIndex = Math.floor(offset / 28) % 21;
  const choIndex = Math.floor(offset / (28 * 21));
  return {
    cho: CHOSEONG[choIndex],
    jung: JUNGSEONG[jungIndex],
    jong: JONGSEONG[jongIndex],
  };
}

/** 초/중/종성을 완성형 음절로 결합. 잘못된 자모면 null. */
export function joinSyllable(syl: Syllable): string | null {
  const choIndex = CHOSEONG.indexOf(syl.cho as (typeof CHOSEONG)[number]);
  const jungIndex = JUNGSEONG.indexOf(syl.jung as (typeof JUNGSEONG)[number]);
  const jongIndex = JONGSEONG.indexOf((syl.jong ?? "") as (typeof JONGSEONG)[number]);
  if (choIndex < 0 || jungIndex < 0 || jongIndex < 0) return null;
  return String.fromCharCode(
    SYLLABLE_BASE + (choIndex * 21 + jungIndex) * 28 + jongIndex,
  );
}

/**
 * 문자열 전체를 자모 배열로 분해한다.
 * 한글이 아닌 문자(영문/숫자/기호)는 그대로 한 원소로 들어간다.
 * 받침 없는 음절은 종성 자리를 만들지 않는다 (길이 왜곡 방지).
 */
export function toJamo(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const syl = splitSyllable(ch);
    if (!syl) {
      out.push(ch);
      continue;
    }
    out.push(syl.cho, syl.jung);
    if (syl.jong) out.push(syl.jong);
  }
  return out;
}

/**
 * 음절 단위 구조를 유지한 채 분해한다.
 * 음운 규칙은 "앞 음절의 종성 + 뒤 음절의 초성" 형태로 적용되므로
 * 규칙 엔진은 평평한 자모 배열이 아니라 이 구조를 입력으로 받는다.
 */
export type Unit = Syllable | { raw: string };

export function isSyllableUnit(u: Unit): u is Syllable {
  return (u as Syllable).cho !== undefined;
}

export function toUnits(text: string): Unit[] {
  const out: Unit[] = [];
  for (const ch of text) {
    const syl = splitSyllable(ch);
    out.push(syl ?? { raw: ch });
  }
  return out;
}

export function unitsToString(units: Unit[]): string {
  let out = "";
  for (const u of units) {
    if (isSyllableUnit(u)) {
      out += joinSyllable(u) ?? "";
    } else {
      out += u.raw;
    }
  }
  return out;
}
