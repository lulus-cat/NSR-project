/**
 * 태움 점수를 체온에 빗댄다.
 *
 * 숫자 점수는 간호사에게 아무 감각도 주지 않지만 체온은 직업 감각 그 자체다.
 * 36.5 는 설명이 필요 없고, 38.6 은 보는 순간 "조치가 필요하다" 로 읽힌다.
 *
 * 점수 → 체온은 레벨 경계에 맞춰 구간별로 잇는다.
 *   0    →  35.8   아주 평온한 날은 미지근한 저체온으로
 *   10   →  37.0   watch 시작 = 미열 시작
 *   30   →  37.6   caution 시작 = 발열 시작
 *   60   →  38.6   severe 시작 = 고열 시작
 *   100  →  40.0
 */

export interface TaeumTemperature {
  celsius: number;
  /** "정상체온" 같은 임상 표현. */
  label: string;
  /** 화면 배지 톤. 기존 레벨 톤과 같은 어휘를 쓴다. */
  tone: "ok" | "muted" | "warn" | "danger";
  /** 한 줄 설명. */
  description: string;
}

const ANCHORS: [number, number][] = [
  [0, 35.8],
  [10, 37.0],
  [30, 37.6],
  [60, 38.6],
  [100, 40.0],
];

export function taeumTemperature(score: number): TaeumTemperature {
  const s = Math.min(100, Math.max(0, Number(score) || 0));

  let celsius = ANCHORS[ANCHORS.length - 1][1];
  for (let i = 1; i < ANCHORS.length; i++) {
    const [x0, y0] = ANCHORS[i - 1];
    const [x1, y1] = ANCHORS[i];
    if (s <= x1) {
      celsius = y0 + ((s - x0) / (x1 - x0)) * (y1 - y0);
      break;
    }
  }
  celsius = Math.round(celsius * 10) / 10;

  if (celsius < 36.0) {
    return {
      celsius,
      label: "저체온",
      tone: "ok",
      description: "더없이 평온한 근무였습니다.",
    };
  }
  if (celsius < 37.0) {
    return {
      celsius,
      label: "정상체온",
      tone: "ok",
      description: "괜찮은 근무 환경입니다.",
    };
  }
  if (celsius <= 37.5) {
    return {
      celsius,
      label: "미열",
      tone: "muted",
      description: "지켜볼 신호가 있었습니다. 인용문을 확인해 보세요.",
    };
  }
  if (celsius <= 38.5) {
    return {
      celsius,
      label: "발열",
      tone: "warn",
      description: "반복되면 기록을 남겨 두세요. 날짜·상황·인용문이 힘이 됩니다.",
    };
  }
  return {
    celsius,
    label: "고열",
    tone: "danger",
    description:
      "혼자 견딜 단계가 아닙니다. 기록을 모으고, 믿을 수 있는 사람과 상의하세요.",
  };
}
