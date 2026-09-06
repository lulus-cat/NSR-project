/**
 * 거리와 이탈 판정.
 *
 * 여기서 지키는 것: **병원 안에서 위성이 튀어도 기록이 안 끊긴다.**
 * 안드로이드는 실내에서 위치가 수백 미터씩 어긋난다. 그 한 번에 근무 중
 * 기록이 끝나면 그날 근무는 통째로 없다.
 */
import { describe, expect, it } from "vitest";
import { GEOFENCE_RADII, distanceMeters, reallyLeft } from "../src/index.js";

const 서울역 = { latitude: 37.5547, longitude: 126.9707 };

describe("거리", () => {
  it("같은 자리는 0m", () => {
    expect(distanceMeters(서울역, 서울역)).toBe(0);
  });

  it("위도 0.001도는 약 111m", () => {
    const d = distanceMeters(서울역, { ...서울역, latitude: 37.5557 });
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(115);
  });

  it("서울역에서 시청까지는 1km 안팎", () => {
    const 시청 = { latitude: 37.5663, longitude: 126.9779 };
    const d = distanceMeters(서울역, 시청);
    expect(d).toBeGreaterThan(1200);
    expect(d).toBeLessThan(1600);
  });
});

describe("이탈 판정", () => {
  it("반경 안이면 안 나간 것이다", () => {
    expect(reallyLeft(120, 250)).toBe(false);
  });

  it("반경을 조금 넘긴 것은 위성 튐으로 본다", () => {
    // 250m 반경에서 300m 는 튐의 범위다 — 여기서 끊으면 근무 중에 기록이 죽는다.
    expect(reallyLeft(300, 250)).toBe(false);
  });

  it("확실히 벗어나면 끊는다", () => {
    expect(reallyLeft(400, 250)).toBe(true);
    expect(reallyLeft(1200, 500)).toBe(true);
  });

  it("작은 반경일수록 여유를 넉넉히 준다", () => {
    // 100m 반경에 30% 만 주면 130m 라 실내 튐에 그대로 끊긴다.
    expect(reallyLeft(180, 100)).toBe(false);
    expect(reallyLeft(220, 100)).toBe(true);
  });

  it("고를 수 있는 반경은 작은 것부터 큰 것까지", () => {
    expect(GEOFENCE_RADII[0]).toBe(100);
    expect(GEOFENCE_RADII.at(-1)).toBe(1000);
  });
});
