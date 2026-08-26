/**
 * 진행률 상태바 알림 — 전사·모델 다운로드·업데이트가 같이 쓴다.
 *
 * 같은 id 의 알림을 계속 덮어써서 하나의 진행 알림처럼 보이게 한다.
 * 5%p 단위로만 갱신한다(매 틱 갱신하면 알림창이 깜빡인다).
 * 권한이 없으면 조용히 생략 — 화면 안 표시는 항상 별도로 된다.
 */

const lastPct = new Map<string, number>();

export async function ensureNotifPermission(): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    const cur = await Notifications.getPermissionsAsync();
    if (!cur.granted && cur.canAskAgain) await Notifications.requestPermissionsAsync();
  } catch {
    // 없으면 없는 대로.
  }
}

export async function notifyProgress(
  id: string,
  percent: number,
  title: string,
  body: string,
): Promise<void> {
  try {
    const prev = lastPct.get(id) ?? -100;
    if (percent - prev < 5 && percent < 100) return;
    lastPct.set(id, percent);
    const Notifications = await import("expo-notifications");
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title, body, sound: false },
      trigger: null,
    });
  } catch {
    // 알림은 편의다. 실패해도 작업은 계속된다.
  }
}

/** 마지막 알림 — 완료·실패. 진행 알림을 이 내용으로 교체한다. */
export async function notifyDone(id: string, title: string, body: string): Promise<void> {
  lastPct.delete(id);
  try {
    const Notifications = await import("expo-notifications");
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title, body, sound: false },
      trigger: null,
    });
  } catch {
    // 위와 같다.
  }
}
