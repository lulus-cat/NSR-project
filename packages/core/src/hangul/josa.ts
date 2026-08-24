/**
 * 조사 고르기.
 *
 * "'폴리'을(를) 담았습니다" 는 사람이 쓴 글로 안 보인다. 받침이 있으면 "을",
 * 없으면 "를" — 규칙이 단순한데 앞말이 변수라서 다들 괄호로 도망간다.
 *
 * 받침 판정은 자모 산술로 끝난다. 한글 음절은
 *   코드 = 0xAC00 + (초성*21 + 중성)*28 + 종성
 * 이므로 (코드 - 0xAC00) % 28 이 0 이면 받침이 없다.
 */

const PAIRS: Record<string, [string, string]> = {
  // [받침 있음, 받침 없음]
  "을": ["을", "를"],
  "를": ["을", "를"],
  "은": ["은", "는"],
  "는": ["은", "는"],
  "이": ["이", "가"],
  "가": ["이", "가"],
  "과": ["과", "와"],
  "와": ["과", "와"],
  "으로": ["으로", "로"],
  "로": ["으로", "로"],
  "이나": ["이나", "나"],
  "나": ["이나", "나"],
  "이라": ["이라", "라"],
  "라": ["이라", "라"],
};

/**
 * 마지막 글자에 받침이 있는가. 한글이 아니면 null (판단 불가).
 *
 * 숫자로 끝나는 경우는 **읽는 소리**로 본다. "3" 은 "삼"이라 받침이 있고
 * "2" 는 "이"라 없다. 병동 대화에는 "302호를", "5번을" 같은 말이 흔하다.
 */
function hasFinalConsonant(word: string): boolean | null {
  const last = word.trim().slice(-1);
  if (!last) return null;

  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;

  // 0 영, 1 일, 2 이, 3 삼, 4 사, 5 오, 6 육, 7 칠, 8 팔, 9 구
  if (last >= "0" && last <= "9") {
    return [true, true, false, true, false, false, true, true, true, false][Number(last)];
  }
  return null;
}

/**
 * 앞말에 맞는 조사를 고른다.
 *
 * @example josa("폴리", "을")   // "를"
 * @example josa("석션", "을")   // "을"
 * @example josa("ABGA", "을")   // "을(를)"  — 못 고르면 그대로 둔다
 */
export function josa(word: string, particle: string): string {
  const pair = PAIRS[particle];
  if (!pair) return particle;

  const final = hasFinalConsonant(word);
  // 한글도 숫자도 아니면(영문 약어 등) 소리를 알 수 없다. 괄호형이 정직하다.
  if (final === null) return pair[0] === "으로" ? "(으)로" : `${pair[0]}(${pair[1]})`;

  // ㄹ 받침은 "으로"가 아니라 "로"를 쓴다. "폴리로", "서울로"
  if (pair[0] === "으로" && final) {
    const code = word.trim().slice(-1).charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 8) return "로";
  }
  return final ? pair[0] : pair[1];
}

/** 앞말과 조사를 붙여서 돌려준다. `${word}${josa(word, p)}` 의 줄임. */
export function withJosa(word: string, particle: string): string {
  return `${word}${josa(word, particle)}`;
}
