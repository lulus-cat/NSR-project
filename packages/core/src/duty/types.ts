/**
 * 듀티표 모델.
 *
 * 3교대의 까다로운 점
 * ------------------
 * 1. **나이트는 자정을 넘는다.** "8월 24일 나이트"는 24일 23시에 시작해 25일 07시에 끝난다.
 *    날짜를 근무 시작일 기준으로 잡되, 종료 시각은 다음 날로 계산해야 한다.
 * 2. **인계 시간은 근무표에 없다.** 데이가 07시 시작이라도 실제 출근은 06시 20분이다.
 *    자동 녹음은 근무표 시각이 아니라 **실제 병동에 있는 시간**을 덮어야 쓸모가 있다.
 * 3. **병원마다 시간이 다르다.** D를 07:00~15:00으로 두는 곳도, 07:00~15:30인 곳도 있다.
 *    그래서 템플릿은 상수가 아니라 사용자 설정이다.
 */

export type ShiftCode =
  | "D" // 데이
  | "E" // 이브닝
  | "N" // 나이트
  | "OFF" // 휴무
  | "ADM" // 상근 (평일 고정 근무)
  | "SPC" // 스페셜 (환자 전담 등 병동이 따로 정하는 근무)
  | "EDU" // 교육
  | "ANNUAL" // 연차
  | "SICK" // 병가
  | "OTHER";

export interface ShiftTemplate {
  code: ShiftCode;
  label: string;
  /** "07:00" 형식. OFF 계열은 빈 문자열. */
  startTime: string;
  endTime: string;
  /** 종료 시각이 다음 날인가. 나이트는 true. */
  crossesMidnight: boolean;
  /** 근무 시작 전 인계 준비 시간(분). 실제 출근 시각을 만든다. */
  preHandoverMin: number;
  /** 근무 종료 후 인계·기록 시간(분). */
  postHandoverMin: number;
  /** 이 코드가 실제 근무인가. OFF/연차는 false. */
  isWorking: boolean;
}

/**
 * 기본 템플릿. 국내 3교대의 가장 흔한 형태를 기준으로 했다.
 * 병원 시간이 다르면 설정 화면에서 통째로 바꾼다.
 */
export const DEFAULT_TEMPLATES: Record<ShiftCode, ShiftTemplate> = {
  D: {
    code: "D",
    label: "데이",
    startTime: "07:00",
    endTime: "15:00",
    crossesMidnight: false,
    preHandoverMin: 40,
    postHandoverMin: 30,
    isWorking: true,
  },
  E: {
    code: "E",
    label: "이브닝",
    startTime: "15:00",
    endTime: "23:00",
    crossesMidnight: false,
    preHandoverMin: 40,
    postHandoverMin: 30,
    isWorking: true,
  },
  N: {
    code: "N",
    label: "나이트",
    startTime: "23:00",
    endTime: "07:00",
    crossesMidnight: true,
    preHandoverMin: 40,
    postHandoverMin: 30,
    isWorking: true,
  },
  OFF: {
    code: "OFF",
    label: "휴무",
    startTime: "",
    endTime: "",
    crossesMidnight: false,
    preHandoverMin: 0,
    postHandoverMin: 0,
    isWorking: false,
  },
  ADM: {
    code: "ADM",
    label: "상근",
    startTime: "09:00",
    endTime: "18:00",
    crossesMidnight: false,
    // 상근은 교대 인계가 없다. 그래도 출근 직후 회의·보고가 있어 조금만 잡는다.
    preHandoverMin: 20,
    postHandoverMin: 10,
    isWorking: true,
  },
  SPC: {
    code: "SPC",
    label: "스페셜",
    // 스페셜은 병동마다 시간이 제각각이다. 기본값은 자리만 잡고,
    // 실제 시각은 항목의 override 나 설정 템플릿으로 바꾼다.
    startTime: "08:00",
    endTime: "20:00",
    crossesMidnight: false,
    preHandoverMin: 30,
    postHandoverMin: 20,
    isWorking: true,
  },
  EDU: {
    code: "EDU",
    label: "교육",
    startTime: "09:00",
    endTime: "18:00",
    crossesMidnight: false,
    preHandoverMin: 0,
    postHandoverMin: 0,
    isWorking: true,
  },
  ANNUAL: {
    code: "ANNUAL",
    label: "연차",
    startTime: "",
    endTime: "",
    crossesMidnight: false,
    preHandoverMin: 0,
    postHandoverMin: 0,
    isWorking: false,
  },
  SICK: {
    code: "SICK",
    label: "병가",
    startTime: "",
    endTime: "",
    crossesMidnight: false,
    preHandoverMin: 0,
    postHandoverMin: 0,
    isWorking: false,
  },
  OTHER: {
    code: "OTHER",
    label: "기타",
    startTime: "",
    endTime: "",
    crossesMidnight: false,
    preHandoverMin: 0,
    postHandoverMin: 0,
    isWorking: false,
  },
};

export interface DutyEntry {
  /** 근무가 **시작하는** 날짜. "2026-08-24" */
  date: string;
  code: ShiftCode;
  /** 이 날만 시간이 다를 때. "06:30" */
  overrideStart?: string;
  overrideEnd?: string;
  note?: string;
}

export interface DutySchedule {
  /** 코드별 시간 정의. 기본값을 사용자가 덮어쓴다. */
  templates: Record<ShiftCode, ShiftTemplate>;
  entries: DutyEntry[];
}

export function createSchedule(entries: DutyEntry[] = []): DutySchedule {
  return { templates: { ...DEFAULT_TEMPLATES }, entries };
}

/** 실제 시각으로 확정된 근무 한 건. */
export interface ResolvedShift {
  /** `${date}:${code}` */
  id: string;
  date: string;
  code: ShiftCode;
  label: string;
  /** 근무표상 시작/종료 (epoch ms). */
  startAt: number;
  endAt: number;
  /** 인계 버퍼를 포함한 실제 체류 시간 (epoch ms). */
  onSiteStartAt: number;
  onSiteEndAt: number;
  isWorking: boolean;
  note?: string;
}
