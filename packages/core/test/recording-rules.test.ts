/**
 * 기록을 켜고 끄는 규칙.
 *
 * 여기 있는 시험은 전부 실제로 났던 사고에서 왔다. 폰에서 확인할 수 없는
 * 코드라 (마이크가 있어야 돈다) 판단만 떼어 여기서 잡는다.
 */
import { describe, expect, it } from "vitest";
import {
  MANUAL_MAX_MS,
  geoDecision,
  tickDecision,
  type SessionState,
} from "../src/index.js";

const 지금 = 1_757_000_000_000;
const 세션 = (over: Partial<SessionState> = {}): SessionState => ({
  owner: "tick",
  shiftId: "2026-09-06:D",
  startedAt: 지금 - 60_000,
  alive: true,
  ...over,
});

describe("듀티표 판정(tick)", () => {
  it("근무 구간이면 켠다", () => {
    expect(tickDecision({ session: null, windowShiftId: "2026-09-06:D", now: 지금 })).toEqual({
      do: "start",
      shiftId: "2026-09-06:D",
      owner: "tick",
    });
  });

  it("구간이 끝나면 자기가 켠 것을 끈다", () => {
    expect(tickDecision({ session: 세션(), windowShiftId: null, now: 지금 })).toEqual({ do: "stop" });
  });

  it("홈 버튼으로 켠 기록은 근무 시각이 아니어도 안 끈다", () => {
    // 이게 안 지켜지면 인계 녹음이 몇 초 만에 꺼진다.
    const s = 세션({ owner: "user", shiftId: "2026-09-06:MANUAL" });
    expect(tickDecision({ session: s, windowShiftId: null, now: 지금 })).toEqual({ do: "none" });
  });

  it("지오펜스로 켠 기록도 안 끈다 — 출근 40분 전 도착이 그렇다", () => {
    const s = 세션({ owner: "geofence" });
    expect(tickDecision({ session: s, windowShiftId: null, now: 지금 })).toEqual({ do: "none" });
  });

  it("수동·지오펜스 기록도 12시간이 지나면 끈다", () => {
    const s = 세션({ owner: "user", startedAt: 지금 - MANUAL_MAX_MS - 1 });
    expect(tickDecision({ session: s, windowShiftId: null, now: 지금 })).toEqual({ do: "stop" });
  });

  it("근무가 바뀌면 새 근무로 다시 켠다", () => {
    const s = 세션({ shiftId: "2026-09-06:D" });
    expect(tickDecision({ session: s, windowShiftId: "2026-09-06:E", now: 지금 })).toEqual({
      do: "start",
      shiftId: "2026-09-06:E",
      owner: "tick",
    });
  });

  it("마이크가 죽은 세션은 누가 켰든 되살린다", () => {
    const s = 세션({ owner: "geofence", alive: false });
    expect(tickDecision({ session: s, windowShiftId: null, now: 지금 })).toEqual({
      do: "revive",
      shiftId: "2026-09-06:D",
      owner: "geofence",
    });
  });

  it("수동 시작이 실패해 세션이 없으면 듀티 기록이 정상으로 켜진다", () => {
    // 예전에는 '수동 시작함' 표시가 남아서 자동 기록이 영영 안 켜졌다.
    expect(tickDecision({ session: null, windowShiftId: "2026-09-06:N", now: 지금 })).toEqual({
      do: "start",
      shiftId: "2026-09-06:N",
      owner: "tick",
    });
  });
});

describe("위치 판정", () => {
  const 기본 = { inside: true, left: false, working: true, stoppedByUserAt: 0, shiftId: "2026-09-06:D" };

  it("근무일에 병동에 들어오면 켠다", () => {
    expect(geoDecision({ ...기본, session: null })).toEqual({
      do: "start",
      shiftId: "2026-09-06:D",
      owner: "geofence",
    });
  });

  it("오프 날에는 안 켠다", () => {
    expect(geoDecision({ ...기본, session: null, working: false })).toEqual({ do: "none" });
  });

  it("사람이 끈 뒤에는 다시 안 켠다", () => {
    // 자리를 비우려고 끈 것을 15분 뒤에 되살리면 그건 사고다.
    expect(geoDecision({ ...기본, session: null, stoppedByUserAt: 지금 })).toEqual({ do: "none" });
  });

  it("홈 버튼으로 켠 기록은 병원 밖에서도 안 끈다", () => {
    const s = 세션({ owner: "user" });
    expect(geoDecision({ ...기본, session: s, inside: false, left: true })).toEqual({ do: "none" });
  });

  it("듀티표가 켠 기록도 위치로 끄지 않는다", () => {
    const s = 세션({ owner: "tick" });
    expect(geoDecision({ ...기본, session: s, inside: false, left: true })).toEqual({ do: "none" });
  });

  it("지오펜스가 켠 기록은 확실히 벗어나면 끈다", () => {
    const s = 세션({ owner: "geofence" });
    expect(geoDecision({ ...기본, session: s, inside: false, left: true })).toEqual({ do: "stop" });
  });

  it("반경을 조금 넘긴 정도로는 안 끈다", () => {
    const s = 세션({ owner: "geofence" });
    expect(geoDecision({ ...기본, session: s, inside: false, left: false })).toEqual({ do: "none" });
  });

  it("이미 켜져 있으면 또 켜지 않는다", () => {
    const s = 세션({ owner: "geofence" });
    expect(geoDecision({ ...기본, session: s })).toEqual({ do: "none" });
  });
});
