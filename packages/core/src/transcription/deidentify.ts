/**
 * 개인정보 가리기.
 *
 * 무엇을 위한 것인가
 * ----------------
 * 전사본에는 환자 이름·등록번호·연락처가 그대로 들어 있다.
 * 그게 기기 밖으로 나가는 순간 의료법 제19조(정보 누설)와
 * 개인정보보호법 제23조(민감정보)의 영역이 된다.
 *
 * 그래서 **밖으로 나가는 길목마다** 이걸 통과시킨다.
 *   - LLM 보조 기능으로 텍스트를 보낼 때
 *   - 보고서를 내보내거나 공유할 때
 *   - 병동 사전을 만들어 동료에게 줄 때
 *
 * 저장할 때는 적용하지 않는다
 * -------------------------
 * 전사본은 증거다. 태움 신고나 노동위원회 절차에서 쓰일 수 있고,
 * 그때 "누구에 대한 이야기였는지"가 통째로 지워져 있으면 증거로서 값이 떨어진다.
 * 그래서 **원본은 그대로 두고, 나갈 때만 가린다.**
 *
 * 이 함수의 한계 — 반드시 화면에 함께 표시할 것
 * -------------------------------------------
 * 완전하지 않다. 한국어 이름은 형태가 다양하고 일반명사와 겹친다.
 * "박 선생님"의 박은 이름이지만 "박 수술"의 박은 아니다. 호칭 없이 이름만
 * 부르는 경우("영희야 이거 좀")는 잡을 방법이 사실상 없다.
 *
 * 그리고 **음성 자체는 가릴 수 없다.** 목소리에는 이름이 그대로 담긴다.
 * 오디오를 밖으로 보내는 경로에서는 이 함수가 아무 역할도 하지 못한다.
 */

import { josa } from "../hangul/josa.js";

/** 가려진 것의 종류. 화면에서 "무엇을 몇 건 가렸는지" 보여주기 위해 나눈다. */
export type PiiKind =
  | "rrn" // 주민등록번호
  | "phone" // 전화번호
  | "mrn" // 등록번호 / 차트번호
  | "name" // 이름 (호칭으로 추정)
  | "dob" // 생년월일
  | "location"; // 병실·침상처럼 사람을 특정할 수 있는 위치

export interface Redaction {
  kind: PiiKind;
  /** 가려진 원문. 되돌리기 화면에서 쓴다. 절대 밖으로 내보내지 않는다. */
  original: string;
  replacement: string;
}

export interface DeidentifyOptions {
  /** 끌 종류. 기본은 location만 꺼져 있다 — 병실 번호는 임상적으로 필요한 경우가 있다. */
  disable?: PiiKind[];
  /** 추가로 가릴 문자열. 사용자가 직접 등록한 이름 등. */
  extraTerms?: readonly string[];
}

export interface DeidentifyResult {
  text: string;
  redactions: Redaction[];
  /** 가린 총 건수. 예전 호출부와의 호환을 위해 남겨 둔다. */
  redactedCount: number;
  /** 종류별 건수. */
  byKind: Partial<Record<PiiKind, number>>;
}

export const PII_LABELS: Record<PiiKind, string> = {
  rrn: "주민등록번호",
  phone: "전화번호",
  mrn: "등록번호",
  name: "이름",
  dob: "생년월일",
  location: "병실·침상",
};

const TOKEN: Record<PiiKind, string> = {
  rrn: "[주민번호]",
  phone: "[전화번호]",
  mrn: "[등록번호]",
  name: "[이름]",
  dob: "[생년월일]",
  location: "[위치]",
};

interface Pattern {
  kind: PiiKind;
  re: RegExp;
  /** 매칭 전체가 아니라 특정 그룹만 가릴 때. */
  group?: number;
}

/**
 * 순서가 중요하다. 구체적인 것부터 본다.
 * 주민번호를 먼저 잡지 않으면 앞 6자리가 등록번호로 먼저 걸린다.
 */
const PATTERNS: Pattern[] = [
  // 주민등록번호 — 하이픈이 없거나 뒤가 마스킹된 형태까지
  { kind: "rrn", re: /\b\d{6}\s*[-–]\s*[1-4*]\d{6}\b/g },
  { kind: "rrn", re: /\b\d{6}\s*[-–]\s*[1-4*]\*{6}/g },

  // 전화번호 — 휴대폰과 지역번호
  { kind: "phone", re: /\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g },
  { kind: "phone", re: /\b0(?:2|[3-6][1-5])[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g },

  // 생년월일
  { kind: "dob", re: /\b(?:19|20)\d{2}\s*[년.\-/]\s*\d{1,2}\s*[월.\-/]\s*\d{1,2}\s*일?/g },

  // 등록번호 — 6자리 이상 연속 숫자. 날짜·수치와 겹치지 않게 앞뒤를 본다.
  // "등록번호 12345678", "차트 12345678", 또는 그냥 8자리 이상
  { kind: "mrn", re: /(?:등록번호|차트번호|환자번호|아이디|ID)\s*[:는은]?\s*(\d{5,})/gi, group: 1 },
  { kind: "mrn", re: /\b\d{8,}\b/g },

  // "○○○ 선생님" — 동료 이름도 가린다 (태움 기록에서 특히).
  // 아래 일반 호칭 규칙보다 **먼저** 봐야 한다. 안 그러면 "선생님"이
  // "선생" + "님"으로 쪼개져 '선생'이 이름으로 잡힌다.
  { kind: "name", re: /([가-힣]{2,4})(?=\s*선생님)/g, group: 1 },
  // 이름 — 호칭이 뒤따르는 2~4음절 한글
  //
  // "환자"는 호칭으로 쓰이기도 하고("박철수 환자 어때요") 그냥 명사이기도 하다
  // ("의사에게 환자 상태 알려"). 둘을 가르는 것은 **앞말이 조사로 끝나는가**다.
  // 이름은 조사로 끝나지 않는다. 그 판정은 `shouldSkip`이 한다.
  {
    kind: "name",
    re: /([가-힣]{2,4})(?=\s*(?:님|씨|환자분|환자|보호자|할머니|할아버지|어머님|아버님|어머니|아버지))/g,
    group: 1,
  },

  // 병실·침상 — 병동에서는 "302호실"보다 "302호"라고 부른다. 둘 다 잡되,
  // 호실이 아닌 '호'(2호선·1호기·3호봉)는 건드리지 않는다.
  {
    kind: "location",
    re: /\b\d{1,4}\s*호(?:실)?(?!선|기|봉|차|점|줄|텔)\s*\d{0,2}\s*번?\s*(?:침상|베드)?/g,
  },
];

/** 이름 패턴이 걸려도 가리면 안 되는 말. 호칭 앞에 오는 흔한 일반명사들. */
const NAME_EXCEPTIONS = new Set([
  "우리", "저기", "이번", "다음", "담당", "옆방", "옆자리", "그분", "이분", "저분",
  "새로", "오늘", "어제", "내일", "방금", "아까", "지금", "고위험", "낙상", "욕창",
  "치매", "중환", "격리", "면회", "일반", "특실", "중환자",
  // 호칭 자체가 이름 자리에 걸리는 말들. "선생님"이 "선생"+"님"으로 쪼개진다.
  "선생", "간호", "수간", "환자", "보호",
]);

/**
 * 이름 자리에 걸렸지만 **조사로 끝나는** 말들.
 *
 * 이름은 조사로 끝나지 않는다. "의사에게", "간호사한테", "병동에서"가
 * 호칭 앞에 오면 규칙은 이름으로 보지만 사람은 그렇게 읽지 않는다.
 * 조사 하나로 걸러지는 오탐이 생각보다 많다.
 */
const TRAILING_PARTICLES = [
  "에게", "한테", "에서", "으로", "까지", "부터", "보다", "처럼",
  "마다", "조차", "밖에", "대로", "이랑", "라고", "라는",
  "하는", "되는", "있는", "없는", "같은",
];

function shouldSkip(kind: PiiKind, value: string): boolean {
  if (kind !== "name") return false;
  if (NAME_EXCEPTIONS.has(value)) return true;
  // 조사만 남는 경우(값 전체가 조사)는 어차피 이름이 아니다.
  return TRAILING_PARTICLES.some((p) => value.endsWith(p));
}

/**
 * 개인정보를 가린다.
 *
 * @example
 *   deidentify("김영희님 등록번호 12345678, 010-1234-5678")
 *   // "[이름]님 등록번호 [등록번호], [전화번호]"
 */
export function deidentify(
  text: string,
  options: DeidentifyOptions = {},
): DeidentifyResult {
  const disabled = new Set<PiiKind>(options.disable ?? ["location"]);
  const redactions: Redaction[] = [];
  let out = text;

  for (const pattern of PATTERNS) {
    if (disabled.has(pattern.kind)) continue;
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    out = out.replace(re, (match, ...groups) => {
      const target = pattern.group ? String(groups[pattern.group - 1] ?? "") : match;
      if (!target || shouldSkip(pattern.kind, target)) return match;
      redactions.push({
        kind: pattern.kind,
        original: target,
        replacement: TOKEN[pattern.kind],
      });
      // 그룹만 가리는 경우 나머지는 살린다 ("김영희님" → "[이름]님")
      return pattern.group ? match.replace(target, TOKEN[pattern.kind]) : TOKEN[pattern.kind];
    });
  }

  // 사용자가 직접 등록한 말. 긴 것부터 바꿔야 부분 치환이 안 생긴다.
  for (const term of [...(options.extraTerms ?? [])].sort((a, b) => b.length - a.length)) {
    const trimmed = term.trim();
    if (trimmed.length < 2) continue;
    let index = out.indexOf(trimmed);
    while (index >= 0) {
      redactions.push({ kind: "name", original: trimmed, replacement: TOKEN.name });
      out = out.slice(0, index) + TOKEN.name + out.slice(index + trimmed.length);
      index = out.indexOf(trimmed, index + TOKEN.name.length);
    }
  }

  const byKind: Partial<Record<PiiKind, number>> = {};
  for (const r of redactions) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  return { text: out, redactions, redactedCount: redactions.length, byKind };
}

/** 화면에 보여줄 한 줄. "이름 2건, 전화번호 1건을 가렸습니다" */
export function describeRedactions(result: DeidentifyResult): string {
  const parts = (Object.keys(result.byKind) as PiiKind[])
    .map((k) => `${PII_LABELS[k]} ${result.byKind[k]}건`)
    .join(", ");
  if (!parts) return "가릴 개인정보를 찾지 못했습니다.";
  return `${parts}${josa(parts, "을")} 가렸습니다.`;
}

/**
 * 밖으로 내보내기 전 최종 점검.
 *
 * 가리기를 통과한 뒤에도 숫자가 많이 남아 있으면 사람이 한 번 봐야 한다.
 * 자동 판정을 믿고 그냥 내보내는 습관이 사고를 만든다.
 */
export interface ExportWarning {
  reason: "many-digits" | "audio-not-maskable" | "nothing-redacted";
  message: string;
}

export function checkBeforeExport(
  result: DeidentifyResult,
  options: { includesAudio?: boolean } = {},
): ExportWarning[] {
  const warnings: ExportWarning[] = [];

  const digitRuns = result.text.match(/\d{4,}/g) ?? [];
  if (digitRuns.length > 0) {
    warnings.push({
      reason: "many-digits",
      message:
        `네 자리 이상 숫자가 ${digitRuns.length}개 남아 있습니다. ` +
        "가리지 못한 번호일 수 있으니 눈으로 확인해 주세요.",
    });
  }

  if (result.redactedCount === 0) {
    warnings.push({
      reason: "nothing-redacted",
      message:
        "가린 것이 하나도 없습니다. 개인정보가 정말 없는 것인지, " +
        "형태가 달라 못 잡은 것인지 확인해 주세요.",
    });
  }

  if (options.includesAudio) {
    warnings.push({
      reason: "audio-not-maskable",
      message:
        "음성 파일은 가릴 수 없습니다. 목소리에는 이름과 진단이 그대로 담깁니다. " +
        "오디오를 함께 보낼 이유가 없다면 빼는 편이 안전합니다.",
    });
  }

  return warnings;
}
