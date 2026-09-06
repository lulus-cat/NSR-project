/**
 * 두 지점 사이의 거리 (미터).
 *
 * 지오펜스가 "나갔다"고 할 때 정말 나간 것인지 다시 재 보려고 쓴다. 병원 안에서
 * 위성이 흔들려 잘못 나온 이탈 신호 하나에 근무 중 기록이 끊기면 안 된다.
 *
 * 하버사인이면 충분하다 — 몇백 미터 거리에서 오차는 1m 아래다.
 */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000; // 지구 반지름 (m)
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 근무지 반경 선택지 (미터). 병원 규모가 제각각이라 사람이 고른다. */
export const GEOFENCE_RADII = [100, 250, 500, 1000] as const;

/**
 * 이탈 신호를 믿어도 되는가.
 *
 * 안드로이드는 실내에서 위치가 수백 미터씩 튄다. 그래서 반경을 조금 넘는
 * 이탈은 무시하고, **확실히 벗어났을 때만** 기록을 끊는다. 여유는 반경의
 * 30% 또는 100m 중 큰 쪽이다 — 작은 반경(100m)일수록 튐에 취약해서 넉넉히 준다.
 */
export function reallyLeft(distance: number, radius: number): boolean {
  return distance > radius + Math.max(100, radius * 0.3);
}
