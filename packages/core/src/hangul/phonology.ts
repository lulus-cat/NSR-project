/**
 * 한국어 음운 변동 규칙 엔진.
 *
 * 왜 필요한가
 * -----------
 * ASR(Whisper 등)은 "들린 소리"를 한글로 적는다. 그래서 표기가 흔들린다.
 *   "폴리 삽입" → "폴리 사빕" (연음을 그대로 적음)
 *   "낙상"      → "낙쌍"     (경음화를 그대로 적음)
 *   "입원"      → "이붠"     (연음)
 * 원문과 ASR 출력은 글자로 보면 다르지만 **발음으로 보면 같다**.
 * 그래서 양쪽을 모두 발음형으로 정규화한 뒤 비교하면 이 오류가 통째로 사라진다.
 *
 * 여기 구현된 규칙은 표준 발음법(한글 맞춤법 부록)의 주요 항목 중
 * ASR 교정에 실효가 큰 것들이다. 100% 표준 발음 구현이 목적이 아니라,
 * "같게 들리는 두 표기를 같은 문자열로 모으는 것"이 목적이다.
 */

import {
  type Syllable,
  type Unit,
  isSyllableUnit,
  toUnits,
  unitsToString,
  toJamo,
} from "./jamo.js";

/** 겹받침 → [뒤 음절로 넘어가지 않고 남는 종성, 초성으로 옮겨갈 자음] */
const CLUSTER_SPLIT: Record<string, [string, string]> = {
  "ㄳ": ["ㄱ", "ㅅ"],
  "ㄵ": ["ㄴ", "ㅈ"],
  "ㄶ": ["ㄴ", "ㅎ"],
  "ㄺ": ["ㄹ", "ㄱ"],
  "ㄻ": ["ㄹ", "ㅁ"],
  "ㄼ": ["ㄹ", "ㅂ"],
  "ㄽ": ["ㄹ", "ㅅ"],
  "ㄾ": ["ㄹ", "ㅌ"],
  "ㄿ": ["ㄹ", "ㅍ"],
  "ㅀ": ["ㄹ", "ㅎ"],
  "ㅄ": ["ㅂ", "ㅅ"],
};

/** 자음군 단순화: 뒤에 모음이 오지 않을 때 겹받침의 대표음. */
const CLUSTER_REDUCE: Record<string, string> = {
  "ㄳ": "ㄱ", "ㄵ": "ㄴ", "ㄶ": "ㄴ", "ㄺ": "ㄱ", "ㄻ": "ㅁ",
  "ㄼ": "ㄹ", "ㄽ": "ㄹ", "ㄾ": "ㄹ", "ㄿ": "ㅂ", "ㅀ": "ㄹ", "ㅄ": "ㅂ",
};

/** 음절 끝소리 규칙(중화): 종성으로 실현되는 자음은 7개뿐이다. */
const NEUTRALIZE: Record<string, string> = {
  "ㄲ": "ㄱ", "ㅋ": "ㄱ",
  "ㅅ": "ㄷ", "ㅆ": "ㄷ", "ㅈ": "ㄷ", "ㅊ": "ㄷ", "ㅌ": "ㄷ", "ㅎ": "ㄷ",
  "ㅍ": "ㅂ",
};

/** ㅎ 축약(격음화)에서 뒤 초성이 바뀌는 방향. */
const ASPIRATED_FROM_ONSET: Record<string, string> = {
  "ㄱ": "ㅋ", "ㄷ": "ㅌ", "ㅈ": "ㅊ", "ㅂ": "ㅍ",
};

/** 앞 종성이 ㅎ과 만나 초성 자리에서 격음이 되는 경우. */
const ASPIRATED_FROM_CODA: Record<string, string> = {
  "ㄱ": "ㅋ", "ㄷ": "ㅌ", "ㅂ": "ㅍ", "ㅈ": "ㅊ", "ㄺ": "ㅋ", "ㄼ": "ㅍ", "ㄵ": "ㅊ",
};

/** 경음화 대상 초성. */
const TENSE: Record<string, string> = {
  "ㄱ": "ㄲ", "ㄷ": "ㄸ", "ㅂ": "ㅃ", "ㅅ": "ㅆ", "ㅈ": "ㅉ",
};

const K_CODAS = new Set(["ㄱ", "ㄲ", "ㅋ", "ㄳ", "ㄺ"]);
const T_CODAS = new Set(["ㄷ", "ㅅ", "ㅆ", "ㅈ", "ㅊ", "ㅌ", "ㅎ"]);
const P_CODAS = new Set(["ㅂ", "ㅍ", "ㄼ", "ㄿ", "ㅄ"]);

/** 비음화 결과 종성. */
const NASAL_OF: Record<string, string> = { "ㄱ": "ㅇ", "ㄷ": "ㄴ", "ㅂ": "ㅁ" };

function codaClass(jong: string): "k" | "t" | "p" | null {
  if (K_CODAS.has(jong)) return "k";
  if (T_CODAS.has(jong)) return "t";
  if (P_CODAS.has(jong)) return "p";
  return null;
}

/**
 * 표준 발음형으로 변환한다.
 *
 * 적용 순서는 표준 발음법의 통상적 적용 순서를 따른다.
 *   격음화 → 연음 → 자음군 단순화 → 구개음화 → 비음화 → 유음화 → 경음화 → 중화
 *
 * @example
 *   pronounce("폴리 삽입")  // "폴리 사빕"
 *   pronounce("낙상")       // "낙쌍"
 *   pronounce("입원")       // "이붠"
 */
export function pronounce(text: string): string {
  const units = toUnits(text);

  for (let i = 0; i < units.length; i++) {
    const cur = units[i];
    if (!isSyllableUnit(cur)) continue;

    // 다음 "음절" 유닛을 찾는다. 공백/기호는 건너뛰되, 그 사이에 문자가
    // 있으면 음운 연결이 끊긴 것으로 보고 규칙을 적용하지 않는다.
    let nextIdx = i + 1;
    while (nextIdx < units.length) {
      const u = units[nextIdx];
      if (isSyllableUnit(u)) break;
      // 공백만 허용 (띄어쓰기를 넘어서도 연음은 실제로 일어난다)
      if (!isSyllableUnit(u) && /^\s$/.test((u as { raw: string }).raw)) {
        nextIdx++;
        continue;
      }
      nextIdx = -1;
      break;
    }
    const next =
      nextIdx > 0 && nextIdx < units.length ? (units[nextIdx] as Syllable) : null;

    if (!next) {
      // 어말: 자음군 단순화 + 중화만 적용
      cur.jong = CLUSTER_REDUCE[cur.jong] ?? cur.jong;
      cur.jong = NEUTRALIZE[cur.jong] ?? cur.jong;
      continue;
    }

    applyPair(cur, next);
  }

  // 마지막으로 남아 있는 겹받침/비중화 종성을 정리한다.
  for (const u of units) {
    if (!isSyllableUnit(u) || !u.jong) continue;
    u.jong = CLUSTER_REDUCE[u.jong] ?? u.jong;
    u.jong = NEUTRALIZE[u.jong] ?? u.jong;
  }

  return unitsToString(units);
}

function applyPair(cur: Syllable, next: Syllable): void {
  // ── 1. 격음화 (ㅎ 축약) ─────────────────────────────────────
  // 앞 종성이 ㅎ 계열: 놓고 → 노코, 많다 → 만타
  if (cur.jong === "ㅎ" || cur.jong === "ㄶ" || cur.jong === "ㅀ") {
    const asp = ASPIRATED_FROM_ONSET[next.cho];
    if (asp) {
      next.cho = asp;
      cur.jong = cur.jong === "ㄶ" ? "ㄴ" : cur.jong === "ㅀ" ? "ㄹ" : "";
      return;
    }
    if (next.cho === "ㅅ") {
      next.cho = "ㅆ";
      cur.jong = cur.jong === "ㄶ" ? "ㄴ" : cur.jong === "ㅀ" ? "ㄹ" : "";
      return;
    }
    if (next.cho === "ㅇ") {
      // 좋아 → 조아 : ㅎ 탈락
      if (cur.jong === "ㅎ") {
        cur.jong = "";
      } else {
        const split = CLUSTER_SPLIT[cur.jong];
        if (split) cur.jong = split[0];
      }
      return;
    }
  }
  // 뒤 초성이 ㅎ: 입학 → 이팍, 축하 → 추카
  if (next.cho === "ㅎ") {
    const asp = ASPIRATED_FROM_CODA[cur.jong];
    if (asp) {
      next.cho = asp;
      const split = CLUSTER_SPLIT[cur.jong];
      cur.jong = split ? split[0] : "";
      return;
    }
  }

  // ── 2. 연음 ────────────────────────────────────────────────
  // 받침이 있고 뒤 초성이 ㅇ(음가 없음)이면 받침이 뒤 초성으로 넘어간다.
  if (cur.jong && next.cho === "ㅇ") {
    const split = CLUSTER_SPLIT[cur.jong];
    if (split) {
      cur.jong = split[0];
      next.cho = split[1];
    } else {
      next.cho = cur.jong === "ㅇ" ? "ㅇ" : cur.jong;
      if (cur.jong !== "ㅇ") cur.jong = "";
    }
    // 연음 후 구개음화: 굳이 → 구지, 같이 → 가치
    if (next.jung === "ㅣ") {
      if (next.cho === "ㄷ") next.cho = "ㅈ";
      else if (next.cho === "ㅌ") next.cho = "ㅊ";
    }
    return;
  }

  // ── 3. 자음군 단순화 ───────────────────────────────────────
  cur.jong = CLUSTER_REDUCE[cur.jong] ?? cur.jong;

  // ── 4. 비음화 ──────────────────────────────────────────────
  const cls = codaClass(cur.jong);
  if (cls && (next.cho === "ㄴ" || next.cho === "ㅁ")) {
    cur.jong = NASAL_OF[cls === "k" ? "ㄱ" : cls === "t" ? "ㄷ" : "ㅂ"];
    return;
  }
  // 종성 ㅁ/ㅇ + 초성 ㄹ → ㄴ  (남루 → 남누, 종로 → 종노)
  if ((cur.jong === "ㅁ" || cur.jong === "ㅇ") && next.cho === "ㄹ") {
    next.cho = "ㄴ";
    return;
  }
  // 종성 ㄱ/ㅂ + 초성 ㄹ → ㅇ/ㅁ + ㄴ  (백로 → 뱅노, 협력 → 혐녁)
  if ((cls === "k" || cls === "p") && next.cho === "ㄹ") {
    cur.jong = cls === "k" ? "ㅇ" : "ㅁ";
    next.cho = "ㄴ";
    return;
  }

  // ── 5. 유음화 ──────────────────────────────────────────────
  if (cur.jong === "ㄴ" && next.cho === "ㄹ") {
    cur.jong = "ㄹ";
    return;
  }
  if (cur.jong === "ㄹ" && next.cho === "ㄴ") {
    next.cho = "ㄹ";
    return;
  }

  // ── 6. 구개음화 (받침 ㄷ/ㅌ + 히) ──────────────────────────
  if (next.cho === "ㅎ" && next.jung === "ㅣ" && (cur.jong === "ㄷ" || cur.jong === "ㅌ")) {
    cur.jong = "";
    next.cho = "ㅊ";
    return;
  }

  // ── 7. 경음화 ──────────────────────────────────────────────
  if (cls) {
    const tensed = TENSE[next.cho];
    if (tensed) {
      next.cho = tensed;
      cur.jong = cls === "k" ? "ㄱ" : cls === "t" ? "ㄷ" : "ㅂ";
      return;
    }
  }

  // ── 8. 중화 ────────────────────────────────────────────────
  cur.jong = NEUTRALIZE[cur.jong] ?? cur.jong;
}

/**
 * 비교용 발음 키.
 * 발음형으로 정규화한 뒤 자모로 펼치고, 공백과 문장부호를 제거한다.
 * 문자열 동일성 비교와 편집거리 계산의 입력으로 쓴다.
 */
export function pronunciationKey(text: string): string {
  const spoken = pronounce(normalizeForCompare(text));
  return toJamo(spoken)
    .filter((j) => !/^[\s.,!?~·…"'()[\]{}\-–—/\\]$/.test(j))
    .join("");
}

/** 비교 전 표면 정규화: 유니코드 정규화, 소문자화, 중복 공백 제거. */
export function normalizeForCompare(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 두 문자열이 같게 발음되는가. */
export function soundsSame(a: string, b: string): boolean {
  return pronunciationKey(a) === pronunciationKey(b);
}

export type { Unit };
