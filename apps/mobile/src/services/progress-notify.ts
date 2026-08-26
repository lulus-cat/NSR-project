/**
 * 진행률 표시 — 전사·모델 다운로드·업데이트가 같이 쓴다.
 *
 * 핵심은 알림이 아니라 **포그라운드 서비스**다. 다른 앱으로 넘어가면
 * Android 가 우리 프로세스를 얼려서(cached app freezer) 소켓이
 * "connection abort"로 끊기고 전사도 멈춘다 — 서비스를 잡고 있는 동안만
 * 면제된다. 서비스 알림이 곧 진행 표시다.
 *
 * 여러 작업이 겹칠 수 있어(다운로드 중 전사 시작) 참조 카운트로 서비스
 * 하나를 나눠 쓴다. 마지막 작업이 끝날 때만 내린다.
 * 서비스가 없는 환경(iOS 등)에서는 예전처럼 일반 알림으로만 보여준다.
 */

import { workStart, workStop, workUpdate } from "../../modules/nsr-audio-decode";

const lastPct = new Map<string, number>();
let workRefs = 0;
let fgsActive = false;

export async function ensureNotifPermission(): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    const cur = await Notifications.getPermissionsAsync();
    if (!cur.granted && cur.canAskAgain) await Notifications.requestPermissionsAsync();
  } catch {
    // 없으면 없는 대로.
  }
}

/**
 * 작업 시작 — 포그라운드 서비스를 잡는다(가능한 환경에서).
 * 사용자가 버튼을 누른 직후(앱이 포그라운드일 때) 불러야 한다.
 */
export async function beginWork(title: string, body: string): Promise<void> {
  await ensureNotifPermission();
  workRefs += 1;
  if (workRefs === 1) fgsActive = workStart(title, body);
  else if (fgsActive) workUpdate(title, body);
}

/**
 * 작업 종료. finalTitle 이 있으면 결과 알림을 하나 남긴다(일반 알림).
 * begin 과 반드시 짝을 이뤄야 한다 — 성공·실패·취소 모든 경로에서.
 */
export async function endWork(
  id: string,
  finalTitle?: string,
  finalBody?: string,
): Promise<void> {
  lastPct.delete(id);
  workRefs = Math.max(0, workRefs - 1);
  if (workRefs === 0 && fgsActive) {
    workStop();
    fgsActive = false;
  }
  try {
    const Notifications = await import("expo-notifications");
    if (finalTitle) {
      if (!(await Notifications.getPermissionsAsync()).granted) return;
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: { title: finalTitle, body: finalBody ?? "", sound: false },
        trigger: null,
      });
    } else {
      await Notifications.dismissNotificationAsync(id);
    }
  } catch {
    // 알림은 편의다.
  }
}

/** 진행 갱신. 5%p 단위로만 실제 표시를 바꾼다. */
export async function notifyProgress(
  id: string,
  percent: number,
  title: string,
  body: string,
): Promise<void> {
  const prev = lastPct.get(id) ?? -100;
  if (percent - prev < 5 && percent < 100) return;
  lastPct.set(id, percent);

  if (fgsActive) {
    workUpdate(title, body);
    return;
  }
  try {
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

/** endWork(id, title, body) 의 별칭 — 기존 호출부와의 이음새. */
export async function notifyDone(id: string, title: string, body: string): Promise<void> {
  await endWork(id, title, body);
}
