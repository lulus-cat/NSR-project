/**
 * 듀티표 해석과 근로시간 지표.
 *
 * 시간대 처리
 * ----------
 * 모든 계산은 **기기 로컬 시간** 기준이다. 국내에서 쓰는 앱이고 표준시가 하나이며
 * 서머타임이 없으므로 이게 가장 단순하고 틀릴 여지가 적다.
 * 해외 근무나 시간대 이동을 지원하려면 여기가 바뀌어야 한다.
 */

import {
  DEFAULT_TEMPLATES,
  type DutyEntry,
  type DutySchedule,
  type ResolvedShift,
  type ShiftCode,
  type ShiftTemplate,
} from "./types.js";

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** "2026-08-24" + "07:00" → 로컬 시간 기준 epoch ms. */
export function toEpoch(date: string, time: string, dayOffset = 0): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
    throw new Error(`잘못된 날짜/시각: ${date} ${time}`);
  }
  return new Date(y, m - 1, d + dayOffset, hh, mm, 0, 0).getTime();
}

/** epoch ms → "2026-08-24" (로컬). */
export function toDateString(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function templateFor(schedule: DutySchedule, code: ShiftCode): ShiftTemplate {
  return schedule.templates[code] ?? DEFAULT_TEMPLATES[code] ?? DEFAULT_TEMPLATES.OTHER;
}

/** 근무 한 건을 실제 시각으로 확정한다. 비근무일이면 null. */
export function resolveShift(
  schedule: DutySchedule,
  entry: DutyEntry,
): ResolvedShift | null {
  const template = templateFor(schedule, entry.code);
  const startTime = entry.overrideStart ?? template.startTime;
  const endTime = entry.overrideEnd ?? template.endTime;
  if (!template.isWorking || !startTime || !endTime) return null;

  const startAt = toEpoch(entry.date, startTime);
  // 종료가 시작보다 이르면 자정을 넘은 것이다. 템플릿 플래그와 무관하게
  // 실제 시각으로 판정하는 편이 override에도 안전하다.
  let endAt = toEpoch(entry.date, endTime);
  if (endAt <= startAt) endAt = toEpoch(entry.date, endTime, 1);

  return {
    id: `${entry.date}:${entry.code}`,
    date: entry.date,
    code: entry.code,
    label: template.label,
    startAt,
    endAt,
    onSiteStartAt: startAt - template.preHandoverMin * MIN_MS,
    onSiteEndAt: endAt + template.postHandoverMin * MIN_MS,
    isWorking: true,
    note: entry.note,
  };
}

/** 근무일만 시간순으로. */
export function resolveAll(schedule: DutySchedule): ResolvedShift[] {
  return schedule.entries
    .map((e) => resolveShift(schedule, e))
    .filter((s): s is ResolvedShift => s !== null)
    .sort((a, b) => a.startAt - b.startAt);
}

// ──────────────────────────────────────────────────────────
//  기피 듀티 패턴
// ──────────────────────────────────────────────────────────

export interface DutyPatternStats {
  /** 나이트 → 오프 → 데이. 밤샘 뒤 하루 쉬고 바로 아침 출근 — 가장 기피되는 배치. */
  naode: number;
  /** 이브닝 다음 날 바로 데이. 23시 퇴근 후 6시대 출근이라 휴식이 8시간이 안 된다. */
  evday: number;
  /** 근무-오프-근무-오프가 4일 이상 이어지는 구간 수. 리듬이 못 잡힌다. */
  pongdang: number;
  /** 데이 3연속 이상 직후 나이트("데데데나"류). 아침 리듬에 맞춰 놓고 밤으로 뒤집는다. */
  dayRunToNight: number;
  /** 나이트 최장 연속 일수. 작성 원칙상 3일을 넘기지 않는 것이 통례다. */
  longestNightRun: number;
  /** 나이트-오프-나이트. 가운데 오프가 잠으로 증발하는 배치. */
  sandwichOff: number;
}

/**
 * 번표에서 기피 배치를 센다. 날짜가 하루씩 연속일 때만 패턴으로 본다 —
 * 사이가 비어 있으면(입력 안 된 날) 패턴이라 단정할 수 없다.
 */
export function dutyPatternStats(entries: DutyEntry[]): DutyPatternStats {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  const nextDay = (date: string): string => {
    const [y, m, d] = date.split("-").map(Number);
    return toDateString(new Date(y, m - 1, d + 1).getTime());
  };
  const byDate = new Map(sorted.map((e) => [e.date, e.code]));

  let naode = 0;
  let evday = 0;
  let dayRunToNight = 0;
  let sandwichOff = 0;
  let dayRun = 0;
  let nightRun = 0;
  let longestNightRun = 0;
  let prevDate: string | null = null;
  for (const e of sorted) {
    const d1 = nextDay(e.date);
    const d2 = nextDay(d1);
    if (e.code === "N" && byDate.get(d1) === "OFF" && byDate.get(d2) === "D") naode++;
    if (e.code === "E" && byDate.get(d1) === "D") evday++;
    if (e.code === "N" && byDate.get(d1) === "OFF" && byDate.get(d2) === "N") sandwichOff++;

    const consecutive = prevDate !== null && nextDay(prevDate) === e.date;
    dayRun = e.code === "D" ? (consecutive ? dayRun + 1 : 1) : 0;
    nightRun = e.code === "N" ? (consecutive ? nightRun + 1 : 1) : 0;
    longestNightRun = Math.max(longestNightRun, nightRun);
    if (dayRun === 0 && e.code === "N") {
      // 어제까지 데이가 3일 이상 이어지다 오늘 나이트로 뒤집힌 경우
      // (dayRun 은 위에서 이미 0 이 됐으므로 직전 값을 따로 본다)
    }
    prevDate = e.date;
  }
  // 데이 연속 뒤 나이트 — 한 번 더 훑는 편이 상태 꼬임 없이 단순하다.
  {
    let run = 0;
    let prev: string | null = null;
    for (const e of sorted) {
      const consecutive = prev !== null && nextDay(prev) === e.date;
      if (e.code === "D") run = consecutive ? run + 1 : 1;
      else {
        if (e.code === "N" && consecutive && run >= 3) dayRunToNight++;
        run = 0;
      }
      prev = e.date;
    }
  }

  // 퐁당퐁당: 일-오프가 번갈아 4일 이상 이어지는 구간.
  let pongdang = 0;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const consecutive = nextDay(prev.date) === cur.date;
    const prevWork = (DEFAULT_TEMPLATES[prev.code] ?? DEFAULT_TEMPLATES.OTHER).isWorking;
    const curWork = (DEFAULT_TEMPLATES[cur.code] ?? DEFAULT_TEMPLATES.OTHER).isWorking;
    if (consecutive && prevWork !== curWork) {
      run++;
    } else {
      if (run >= 4) pongdang++;
      run = 1;
    }
  }
  if (run >= 4) pongdang++;

  return { naode, evday, pongdang, dayRunToNight, longestNightRun, sandwichOff };
}

// ──────────────────────────────────────────────────────────
//  자동 녹음
// ──────────────────────────────────────────────────────────

export interface RecordingPolicy {
  enabled: boolean;
  /** 근무 시작 몇 분 전부터 녹음할지. 인계를 놓치지 않으려면 인계 버퍼보다 넉넉해야 한다. */
  leadMinutes: number;
  /** 근무 종료 후 몇 분까지. */
  trailMinutes: number;
  /** 자동 녹음을 켤 근무 코드. */
  codes: ShiftCode[];
  /**
   * 파일 분할 간격(분). 8시간을 한 파일로 두면 손상 시 전부 잃고,
   * 전사도 늦어진다. 30분 단위 분할이면 근무 중에도 순차 전사가 가능하다.
   */
  segmentMinutes: number;
  /** 로컬 저장 상한(MB). 넘으면 오래된 것부터 지운다. */
  maxStorageMb: number;
  /** 자동 삭제까지의 일수. 0이면 자동 삭제하지 않는다. */
  retentionDays: number;
  /** 시작·종료 시 소리·진동 없이. */
  silentStart: boolean;
  /**
   * 앱 알림을 띄우지 않는다.
   * 주의: iOS/Android의 **OS 마이크 인디케이터는 앱이 끌 수 없다**.
   * 자세한 내용은 docs/01-legal-and-privacy.md 참고.
   */
  suppressNotifications: boolean;
}

export const DEFAULT_RECORDING_POLICY: RecordingPolicy = {
  enabled: false, // 명시적으로 켜야 한다. 기본값이 켜짐이면 안 된다.
  leadMinutes: 45,
  trailMinutes: 40,
  codes: ["D", "E", "N", "ADM", "SPC"],
  segmentMinutes: 30,
  maxStorageMb: 4096,
  retentionDays: 30,
  silentStart: true,
  suppressNotifications: true,
};

export interface RecordingWindow {
  shiftId: string;
  code: ShiftCode;
  label: string;
  date: string;
  startAt: number;
  endAt: number;
}

/** 정책과 듀티표로부터 자동 녹음 구간을 만든다. */
export function recordingWindows(
  schedule: DutySchedule,
  policy: RecordingPolicy,
  range?: { from: number; to: number },
): RecordingWindow[] {
  if (!policy.enabled) return [];
  const allowed = new Set(policy.codes);
  const windows: RecordingWindow[] = [];
  for (const shift of resolveAll(schedule)) {
    if (!allowed.has(shift.code)) continue;
    const startAt = shift.startAt - policy.leadMinutes * MIN_MS;
    const endAt = shift.endAt + policy.trailMinutes * MIN_MS;
    if (range && (endAt < range.from || startAt > range.to)) continue;
    windows.push({
      shiftId: shift.id,
      code: shift.code,
      label: shift.label,
      date: shift.date,
      startAt,
      endAt,
    });
  }
  return windows.sort((a, b) => a.startAt - b.startAt);
}

/** 지금 녹음해야 하는가. 백그라운드 태스크가 매 틱 호출한다. */
export function activeWindowAt(
  windows: RecordingWindow[],
  at: number,
): RecordingWindow | null {
  for (const w of windows) {
    if (at >= w.startAt && at <= w.endAt) return w;
  }
  return null;
}

/** 다음 녹음 시작까지 남은 시간. 백그라운드 깨우기 예약에 쓴다. */
export function nextWindowAfter(
  windows: RecordingWindow[],
  at: number,
): RecordingWindow | null {
  let best: RecordingWindow | null = null;
  for (const w of windows) {
    if (w.startAt <= at) continue;
    if (!best || w.startAt < best.startAt) best = w;
  }
  return best;
}

/** 한 녹음 구간을 파일 단위로 쪼갠다. */
export function splitIntoSegments(
  window: RecordingWindow,
  segmentMinutes: number,
): { index: number; startAt: number; endAt: number }[] {
  const step = Math.max(1, segmentMinutes) * MIN_MS;
  const out: { index: number; startAt: number; endAt: number }[] = [];
  let index = 0;
  for (let t = window.startAt; t < window.endAt; t += step) {
    out.push({ index, startAt: t, endAt: Math.min(t + step, window.endAt) });
    index += 1;
  }
  return out;
}

// ──────────────────────────────────────────────────────────
//  듀티표 입력 보조
// ──────────────────────────────────────────────────────────

const CODE_ALIASES: Record<string, ShiftCode> = {
  D: "D", 데: "D", 데이: "D",
  E: "E", 이: "E", 이브닝: "E",
  N: "N", 나: "N", 나이트: "N",
  O: "OFF", OFF: "OFF", 오: "OFF", 오프: "OFF", 휴: "OFF", "-": "OFF", "/": "OFF",
  상: "ADM", 상근: "ADM",
  스: "SPC", 스페셜: "SPC", S: "SPC",
  교육: "EDU", EDU: "EDU",
  연: "ANNUAL", 연차: "ANNUAL", A: "ANNUAL",
  병: "SICK", 병가: "SICK",
};

/**
 * 듀티표를 문자열로 받아 항목으로 만든다.
 *
 * 병동 듀티표는 대개 종이나 엑셀 한 줄로 온다. 한 칸씩 앱에 입력하게 만들면
 * 아무도 안 쓴다. "DDEENNOO" 또는 "D D E E N N O O" 또는 "데데이이나나오오"를
 * 그대로 붙여넣을 수 있어야 한다.
 *
 * @param startDate 첫 글자에 해당하는 날짜 "2026-08-01"
 */
export function parseDutyString(startDate: string, input: string): DutyEntry[] {
  const lookup = (token: string): ShiftCode | undefined =>
    CODE_ALIASES[token] ?? CODE_ALIASES[token.toUpperCase()];

  // 공백으로 끊긴 덩어리가 통째로 코드면("데이", "OFF") 그 단위를 존중하고,
  // 아니면 한 글자씩 쪼갠다("DDEENN" → D D E E N N).
  const tokens = input
    .trim()
    .split(/[\s,|]+/)
    .filter(Boolean)
    .flatMap((chunk) => (lookup(chunk) ? [chunk] : [...chunk]));

  const entries: DutyEntry[] = [];
  let dayOffset = 0;
  for (const token of tokens) {
    const code = lookup(token);
    if (!code) throw new Error(`알 수 없는 듀티 기호: "${token}"`);
    entries.push({ date: toDateString(toEpoch(startDate, "00:00", dayOffset)), code });
    dayOffset += 1;
  }
  return entries;
}

// ──────────────────────────────────────────────────────────
//  근로시간 지표
// ──────────────────────────────────────────────────────────

export interface LaborStats {
  /** 근무표상 총 근무시간. 인계 버퍼는 제외. */
  scheduledHours: number;
  /** 인계 버퍼를 포함한 실제 체류 시간. 둘의 차이가 '보이지 않는 노동'이다. */
  onSiteHours: number;
  /** 야간근로(22:00~06:00) 시간. 근로기준법 제56조 가산수당 대상. */
  nightHours: number;
  /**
   * 근무표에 안 적힌 초과 체류. onSite - scheduled 다.
   *
   * 인계가 길어져 남는 시간이 여기 쌓인다. 이게 수당으로 잡히지 않으면
   * **공짜로 일한 시간**이고, 신규간호사에게 가장 흔한 형태다.
   */
  offTheBooksHours: number;
  /**
   * 주 40시간을 넘긴 시간. 근로기준법 제50조의 소정근로시간 기준이다.
   * 체류 시간(onSite)으로 센다 — 실제로 병원에 있던 시간이 기준이어야 한다.
   */
  overtimeHours: number;
  nightShiftCount: number;
  /** 최장 연속 근무일수. */
  longestConsecutiveDays: number;
  /**
   * 근무 종료와 다음 근무 시작 사이가 11시간 미만인 횟수.
   * 보건업은 근로시간 특례업종이며, 특례를 도입한 사업장은 근로기준법 제59조 제2항에 따라
   * 근무일 사이에 연속 11시간 이상의 휴식시간을 주어야 한다.
   */
  quickReturns: { fromShiftId: string; toShiftId: string; gapHours: number }[];
  shiftCount: number;
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * 한 구간에서 야간근로 시간대(22:00~06:00)에 해당하는 시간(ms).
 *
 * 날짜별로 서로 겹치지 않는 두 조각 - [00:00, 06:00)과 [22:00, 24:00) - 으로 나눠
 * 각각 겹침을 더한다. 자정을 넘는 나이트도 이 방식이면 이중 계산 없이 정확하다.
 */
function nightMillis(startAt: number, endAt: number): number {
  if (endAt <= startAt) return 0;
  const first = new Date(startAt);
  first.setHours(0, 0, 0, 0);
  let total = 0;
  for (let dayStart = first.getTime(); dayStart < endAt; dayStart += DAY_MS) {
    total += overlapMs(startAt, endAt, dayStart, dayStart + 6 * HOUR_MS);
    total += overlapMs(startAt, endAt, dayStart + 22 * HOUR_MS, dayStart + DAY_MS);
  }
  return total;
}

/** ISO 주(월요일 시작) 키. 주 단위 집계에 쓴다. */
function weekKey(at: number): string {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  // 월요일로 당긴다. getDay()는 일=0 이므로 그 경우 6일 전이 월요일이다.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function laborStats(shifts: ResolvedShift[]): LaborStats {
  const sorted = [...shifts].sort((a, b) => a.startAt - b.startAt);
  let scheduledMs = 0;
  let onSiteMs = 0;
  let nightMs = 0;
  let nightShiftCount = 0;
  const quickReturns: LaborStats["quickReturns"] = [];

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    scheduledMs += s.endAt - s.startAt;
    onSiteMs += s.onSiteEndAt - s.onSiteStartAt;
    nightMs += nightMillis(s.startAt, s.endAt);
    if (s.code === "N") nightShiftCount += 1;

    const next = sorted[i + 1];
    if (next) {
      const gap = next.startAt - s.endAt;
      if (gap < 11 * HOUR_MS) {
        quickReturns.push({
          fromShiftId: s.id,
          toShiftId: next.id,
          gapHours: Math.round((gap / HOUR_MS) * 10) / 10,
        });
      }
    }
  }

  // 연속 근무일: 근무 시작 날짜가 하루씩 이어지는 최장 구간
  let longest = 0;
  let run = 0;
  let prevDate: string | null = null;
  for (const s of sorted) {
    if (prevDate === null) {
      run = 1;
    } else {
      const expected = toDateString(toEpoch(prevDate, "00:00", 1));
      run = s.date === expected ? run + 1 : s.date === prevDate ? run : 1;
    }
    if (run > longest) longest = run;
    prevDate = s.date;
  }

  // 주 40시간 초과분. 주마다 따로 세야 한다 — 2주치를 합쳐 80시간으로 보면
  // 한 주에 몰아 일한 것이 안 보인다.
  const byWeek = new Map<string, number>();
  for (const s of sorted) {
    const k = weekKey(s.startAt);
    byWeek.set(k, (byWeek.get(k) ?? 0) + (s.onSiteEndAt - s.onSiteStartAt));
  }
  let overtimeMs = 0;
  for (const ms of byWeek.values()) overtimeMs += Math.max(0, ms - 40 * HOUR_MS);

  return {
    scheduledHours: Math.round((scheduledMs / HOUR_MS) * 10) / 10,
    onSiteHours: Math.round((onSiteMs / HOUR_MS) * 10) / 10,
    nightHours: Math.round((nightMs / HOUR_MS) * 10) / 10,
    offTheBooksHours: Math.round(((onSiteMs - scheduledMs) / HOUR_MS) * 10) / 10,
    overtimeHours: Math.round((overtimeMs / HOUR_MS) * 10) / 10,
    nightShiftCount,
    longestConsecutiveDays: longest,
    quickReturns,
    shiftCount: sorted.length,
  };
}

export interface LaborWarning {
  kind: "weekly-hours" | "quick-return" | "consecutive-days" | "consecutive-nights";
  message: string;
  /** 관련 법 조항. 위반 판정이 아니라 확인해볼 지점을 알려주는 것. */
  reference?: string;
}

/**
 * 근무표에서 확인해볼 지점을 찾는다.
 *
 * 이건 위법 판정이 아니다. 근로시간 계산은 임금체계·교대제 합의·특례 도입 여부에 따라
 * 달라지므로 앱이 단정할 수 없다. 여기서 하는 일은 "이 부분은 확인해볼 만하다"를
 * 짚어주고 근거 조문을 함께 보여주는 것까지다.
 */
export function laborWarnings(
  shifts: ResolvedShift[],
  stats = laborStats(shifts),
): LaborWarning[] {
  const warnings: LaborWarning[] = [];

  if (stats.quickReturns.length > 0) {
    const worst = stats.quickReturns.reduce((a, b) => (b.gapHours < a.gapHours ? b : a));
    warnings.push({
      kind: "quick-return",
      message:
        `근무 간 휴식시간 11시간 미만 ${stats.quickReturns.length}회 발생` +
        `(최단 간격 ${worst.gapHours}시간). 출퇴근 및 식사 시간을 제외하면 실질 휴식이 부족합니다.`,
      reference:
        "근로기준법 제59조 제2항 — 보건업 등 특례사업장은 근무일 간 11시간 이상의 연속 휴식시간을 보장해야 합니다.",
    });
  }

  if (stats.longestConsecutiveDays >= 6) {
    warnings.push({
      kind: "consecutive-days",
      message: `최장 연속 근무일수는 ${stats.longestConsecutiveDays}일입니다.`,
      reference:
        "근로기준법 제55조 — 사용자는 1주에 평균 1회 이상의 유급휴일을 보장해야 합니다.",
    });
  }

  if (stats.nightShiftCount >= 3) {
    warnings.push({
      kind: "consecutive-nights",
      message:
        `해당 기간 야간근무 ${stats.nightShiftCount}회, 야간근로 총 ${stats.nightHours}시간입니다.`,
      reference:
        "근로기준법 제56조 제3항 — 야간근로(22시~06시)는 통상임금의 50% 이상을 가산 지급해야 합니다. 급여명세서를 확인하십시오.",
    });
  }

  if (stats.scheduledHours > 52) {
    warnings.push({
      kind: "weekly-hours",
      message: `해당 구간의 예정 근무시간은 총 ${stats.scheduledHours}시간입니다. 주 단위 근로시간을 확인하십시오.`,
      reference:
        "근로기준법 제50조·제53조 — 주당 소정근로 40시간, 연장근로 포함 최대 52시간 기준입니다 (탄력근로/특례 도입 시 변동 가능).",
    });
  }

  return warnings;
}
