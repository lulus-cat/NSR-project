import { describe, it, expect } from "vitest";
import {
  createSchedule,
  resolveShift,
  resolveAll,
  parseDutyString,
  recordingWindows,
  activeWindowAt,
  nextWindowAfter,
  splitIntoSegments,
  laborStats,
  laborWarnings,
  toEpoch,
  toDateString,
  DEFAULT_RECORDING_POLICY,
  type RecordingPolicy,
} from "../src/duty/index.js";

const policy: RecordingPolicy = { ...DEFAULT_RECORDING_POLICY, enabled: true };

describe("근무 시각 확정", () => {
  it("데이 근무를 시각으로 바꾼다", () => {
    const s = createSchedule([{ date: "2026-08-24", code: "D" }]);
    const shift = resolveShift(s, s.entries[0])!;
    expect(new Date(shift.startAt).getHours()).toBe(7);
    expect(new Date(shift.endAt).getHours()).toBe(15);
    expect(new Date(shift.endAt).getDate()).toBe(24);
  });

  it("나이트는 종료가 다음 날이다", () => {
    const s = createSchedule([{ date: "2026-08-24", code: "N" }]);
    const shift = resolveShift(s, s.entries[0])!;
    expect(new Date(shift.startAt).getDate()).toBe(24);
    expect(new Date(shift.endAt).getDate()).toBe(25);
    expect(new Date(shift.endAt).getHours()).toBe(7);
    expect(shift.endAt - shift.startAt).toBe(8 * 3600 * 1000);
  });

  it("인계 버퍼가 실제 체류 시간에 반영된다", () => {
    const s = createSchedule([{ date: "2026-08-24", code: "D" }]);
    const shift = resolveShift(s, s.entries[0])!;
    expect(shift.onSiteStartAt).toBeLessThan(shift.startAt);
    expect(shift.onSiteEndAt).toBeGreaterThan(shift.endAt);
  });

  it("오프는 근무로 확정되지 않는다", () => {
    const s = createSchedule([{ date: "2026-08-24", code: "OFF" }]);
    expect(resolveShift(s, s.entries[0])).toBeNull();
  });

  it("개별 시간 덮어쓰기가 자정 넘김도 처리한다", () => {
    const s = createSchedule([
      { date: "2026-08-24", code: "D", overrideStart: "22:00", overrideEnd: "02:00" },
    ]);
    const shift = resolveShift(s, s.entries[0])!;
    expect(new Date(shift.endAt).getDate()).toBe(25);
  });
});

describe("듀티표 문자열 파싱", () => {
  it("붙여쓴 영문 코드를 한 글자씩 읽는다", () => {
    const entries = parseDutyString("2026-08-01", "DDEENNOO");
    expect(entries).toHaveLength(8);
    expect(entries[0]).toEqual({ date: "2026-08-01", code: "D" });
    expect(entries[4]).toEqual({ date: "2026-08-05", code: "N" });
    expect(entries[7].code).toBe("OFF");
  });

  it("공백으로 나뉜 한글 표기를 읽는다", () => {
    const entries = parseDutyString("2026-08-01", "데이 데이 나이트 오프");
    expect(entries.map((e) => e.code)).toEqual(["D", "D", "N", "OFF"]);
  });

  it("붙여쓴 한글 한 글자 표기를 읽는다", () => {
    expect(parseDutyString("2026-08-01", "데데이이나나오오").map((e) => e.code)).toEqual([
      "D", "D", "E", "E", "N", "N", "OFF", "OFF",
    ]);
  });

  it("월말을 넘어가면 날짜가 이어진다", () => {
    const entries = parseDutyString("2026-08-30", "DDD");
    expect(entries.map((e) => e.date)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
  });

  it("모르는 기호는 오류", () => {
    expect(() => parseDutyString("2026-08-01", "DXD")).toThrow(/알 수 없는/);
  });
});

describe("자동 녹음 구간", () => {
  const schedule = createSchedule(parseDutyString("2026-08-24", "DENO"));

  it("정책이 꺼져 있으면 구간이 없다", () => {
    expect(recordingWindows(schedule, DEFAULT_RECORDING_POLICY)).toHaveLength(0);
  });

  it("근무일에만 구간을 만든다", () => {
    const windows = recordingWindows(schedule, policy);
    expect(windows).toHaveLength(3);
    expect(windows.map((w) => w.code)).toEqual(["D", "E", "N"]);
  });

  it("근무 시작보다 이르게 시작하고 종료보다 늦게 끝난다", () => {
    const w = recordingWindows(schedule, policy)[0];
    expect(w.startAt).toBe(toEpoch("2026-08-24", "07:00") - 45 * 60000);
    expect(w.endAt).toBe(toEpoch("2026-08-24", "15:00") + 40 * 60000);
  });

  it("지금이 녹음 시간인지 판정한다", () => {
    const windows = recordingWindows(schedule, policy);
    expect(activeWindowAt(windows, toEpoch("2026-08-24", "09:00"))?.code).toBe("D");
    expect(activeWindowAt(windows, toEpoch("2026-08-24", "05:00"))).toBeNull();
  });

  it("다음 녹음 시작을 찾는다", () => {
    const windows = recordingWindows(schedule, policy);
    const next = nextWindowAfter(windows, toEpoch("2026-08-24", "05:00"));
    expect(next?.code).toBe("D");
  });

  it("긴 구간을 파일 단위로 쪼갠다", () => {
    const w = recordingWindows(schedule, policy)[0];
    const parts = splitIntoSegments(w, 30);
    expect(parts.length).toBe(Math.ceil((w.endAt - w.startAt) / (30 * 60000)));
    expect(parts[0].startAt).toBe(w.startAt);
    expect(parts[parts.length - 1].endAt).toBe(w.endAt);
  });

  it("정책에서 뺀 근무 코드는 녹음하지 않는다", () => {
    const dayOnly = recordingWindows(schedule, { ...policy, codes: ["D"] });
    expect(dayOnly.map((w) => w.code)).toEqual(["D"]);
  });
});

describe("근로시간 지표", () => {
  it("야간근로 시간을 22시~06시 기준으로 센다", () => {
    const s = createSchedule([{ date: "2026-08-24", code: "N" }]);
    const stats = laborStats(resolveAll(s));
    // 23:00~07:00 중 야간대는 23:00~06:00 = 7시간
    expect(stats.nightHours).toBe(7);
    expect(stats.nightShiftCount).toBe(1);
  });

  it("데이 근무에는 야간근로가 없다", () => {
    const s = createSchedule([{ date: "2026-08-24", code: "D" }]);
    expect(laborStats(resolveAll(s)).nightHours).toBe(0);
  });

  it("인계 버퍼가 근무표 시간과의 차이로 드러난다", () => {
    const s = createSchedule(parseDutyString("2026-08-24", "DDD"));
    const stats = laborStats(resolveAll(s));
    expect(stats.scheduledHours).toBe(24);
    expect(stats.onSiteHours).toBeCloseTo(24 + 3 * (70 / 60), 1);
  });

  it("근무 간 11시간 미만 간격을 찾는다", () => {
    // 이브닝(~23:00) 다음날 데이(07:00~) = 8시간 간격
    const s = createSchedule(parseDutyString("2026-08-24", "ED"));
    const stats = laborStats(resolveAll(s));
    expect(stats.quickReturns).toHaveLength(1);
    expect(stats.quickReturns[0].gapHours).toBe(8);
  });

  it("데이-오프-데이는 짧은 간격으로 세지 않는다", () => {
    const s = createSchedule(parseDutyString("2026-08-24", "DOD"));
    expect(laborStats(resolveAll(s)).quickReturns).toHaveLength(0);
  });

  it("연속 근무일수를 센다", () => {
    const s = createSchedule(parseDutyString("2026-08-24", "DDDDDOOD"));
    expect(laborStats(resolveAll(s)).longestConsecutiveDays).toBe(5);
  });

  it("확인할 지점에 근거 조문을 붙여 알려준다", () => {
    const s = createSchedule(parseDutyString("2026-08-24", "EDEDEDD"));
    const warnings = laborWarnings(resolveAll(s));
    const quick = warnings.find((w) => w.kind === "quick-return");
    expect(quick).toBeDefined();
    expect(quick!.reference).toContain("제59조");
    const consecutive = warnings.find((w) => w.kind === "consecutive-days");
    expect(consecutive?.reference).toContain("제55조");
  });

  it("근무가 없으면 지표가 0", () => {
    const stats = laborStats([]);
    expect(stats.shiftCount).toBe(0);
    expect(laborWarnings([], stats)).toHaveLength(0);
  });
});

describe("날짜 변환", () => {
  it("epoch와 날짜 문자열을 왕복한다", () => {
    expect(toDateString(toEpoch("2026-08-24", "13:00"))).toBe("2026-08-24");
  });
});
