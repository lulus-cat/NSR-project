/**
 * 전사 러너 — 전사를 화면이 아니라 여기서 돌린다.
 *
 * 전에는 근무 기록 화면의 버튼 핸들러가 루프를 돌았다. 화면을 벗어나면
 * 진행을 볼 수 없고, 오류는 사라지고, 사용자는 "중단됐다"고 느낀다.
 * 러너는 모듈 스코프 싱글턴이라 화면 이동과 무관하게 끝까지 돌고,
 * 어느 화면이든 구독으로 진행률을 읽는다.
 *
 * 상태바 알림: 진행률을 같은 id 의 알림으로 계속 덮어쓴다. 알림 권한이
 * 없으면 조용히 생략한다 — 화면 안 표시는 항상 된다.
 *
 * 한계(정직): 앱 프로세스가 살아 있는 동안 계속된다. 화면을 끄거나 다른
 * 앱을 써도 대개 이어지지만, 시스템이 앱을 완전히 종료하면 멈추고
 * 남은 파일은 '전사할 기록'으로 되돌아온다.
 */

import type { RecordingRow } from "../db";
import { processRecording, resolveProvider } from "./asr";
import { logDebug } from "./debug";

export interface RunnerState {
  running: boolean;
  shiftId: string | null;
  /** 지금 몇 번째 파일인가 (1부터). */
  fileIndex: number;
  fileCount: number;
  /** 전체 작업 기준 0~100. */
  percent: number;
  /** 끝난 뒤 한 번 보여줄 오류. 새 작업을 시작하면 지워진다. */
  error: string | null;
  /** 마지막 완료 작업의 문장 수 합계. 화면 새로고침 신호로도 쓴다. */
  completedAt: number | null;
}

let state: RunnerState = {
  running: false,
  shiftId: null,
  fileIndex: 0,
  fileCount: 0,
  percent: 0,
  error: null,
  completedAt: null,
};

const listeners = new Set<(s: RunnerState) => void>();

export function runnerState(): RunnerState {
  return state;
}

export function subscribeRunner(fn: (s: RunnerState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(patch: Partial<RunnerState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

const NOTIF_ID = "nsr-transcribe-progress";
let lastNotifiedPct = -100;

async function notify(title: string, body: string, done = false): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    if (!done) {
      // 진행 알림은 5%p 단위로만 갱신 — 매 틱 갱신하면 알림창이 깜빡인다.
      if (state.percent - lastNotifiedPct < 5) return;
      lastNotifiedPct = state.percent;
    }
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return; // 권한이 없으면 화면 표시만 한다.
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIF_ID,
      content: { title, body, sound: false },
      trigger: null,
    });
  } catch {
    // 알림은 편의다. 실패해도 전사는 계속된다.
  }
}

/** 첫 전사 시작 때 한 번 알림 권한을 청한다. 거절해도 전사는 된다. */
async function ensureNotifPermission(): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    const cur = await Notifications.getPermissionsAsync();
    if (!cur.granted && cur.canAskAgain) await Notifications.requestPermissionsAsync();
  } catch {
    // 없으면 없는 대로.
  }
}

/**
 * 전사 작업을 시작한다. 이미 돌고 있으면 무시한다(한 번에 하나).
 * 돌아오는 Promise 를 기다릴 필요 없다 — 진행은 구독으로 본다.
 */
export function startTranscription(shiftId: string, recordings: RecordingRow[]): boolean {
  if (state.running) return false;
  const files = recordings.filter((r) => r.state === "recorded" && r.file_uri);
  if (files.length === 0) return false;

  lastNotifiedPct = -100;
  emit({
    running: true,
    shiftId,
    fileIndex: 1,
    fileCount: files.length,
    percent: 0,
    error: null,
  });

  void (async () => {
    await ensureNotifPermission();
    try {
      const provider = await resolveProvider();
      for (let i = 0; i < files.length; i++) {
        emit({ fileIndex: i + 1, percent: Math.round((i / files.length) * 100) });
        await notify(
          `전사 중 ${state.percent}%`,
          `파일 ${i + 1}/${files.length} · 화면을 닫아도 계속됩니다`,
        );
        await processRecording(files[i], provider, (filePct) => {
          const overall = Math.round(((i + filePct / 100) / files.length) * 100);
          if (overall !== state.percent) {
            emit({ percent: overall });
            void notify(
              `전사 중 ${overall}%`,
              `파일 ${i + 1}/${files.length} · 화면을 닫아도 계속됩니다`,
            );
          }
        });
      }
      emit({ running: false, percent: 100, completedAt: Date.now() });
      await notify("전사 완료", `기록 ${files.length}건을 전사했습니다.`, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "전사에 실패했습니다.";
      void logDebug(`전사 실패: ${msg}`);
      emit({ running: false, error: msg, completedAt: Date.now() });
      await notify("전사 중단", msg, true);
    }
  })();

  return true;
}
