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

// 60점(severe 진입)까지는 임상 눈금을 지키고, 그 위로는 일부러 과장한다.
// 40도에서 멈추면 "심각"과 "재난"이 같은 숫자로 보인다 — 60도가 주는
// 직관(사람이 버틸 온도가 아니다)이 이 지표의 존재 이유에 맞는다.
const ANCHORS: [number, number][] = [
  [0, 35.8],
  [10, 37.0],
  [30, 37.6],
  [60, 38.6],
  [80, 45.0],
  [100, 62.0],
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
      description: "안정적인 근무 환경입니다.",
    };
  }
  if (celsius < 37.0) {
    return {
      celsius,
      label: "정상체온",
      tone: "ok",
      description: "양호한 근무 환경입니다.",
    };
  }
  if (celsius <= 37.5) {
    return {
      celsius,
      label: "미열",
      tone: "muted",
      description: "주의가 필요한 발언이 기록되었습니다. 인용문을 확인하십시오.",
    };
  }
  if (celsius <= 38.5) {
    return {
      celsius,
      label: "발열",
      tone: "warn",
      description: "지속 발생 시 날짜·상황·인용문 기록을 보관하십시오.",
    };
  }
  if (celsius <= 42.0) {
    return {
      celsius,
      label: "고열",
      tone: "danger",
      description: "전문적인 도움이 필요한 상태입니다. 기록을 취합하여 상담을 진행하십시오.",
    };
  }
  if (celsius <= 50.0) {
    return {
      celsius,
      label: "위험 고열",
      tone: "danger",
      description: "사람이 견딜 온도가 아닙니다. 이 병동의 문제이지 당신의 문제가 아닙니다.",
    };
  }
  return {
    celsius,
    label: "체온계 파손",
    tone: "danger",
    description: "측정 한계를 넘었습니다. 기록을 모아 두십시오 — 이 숫자 자체가 증거입니다.",
  };
}
