/**
 * 듀티표 기반 자동 녹음 스케줄러.
 *
 * 플랫폼별로 되는 정도가 다르다. 이걸 숨기면 사용자는 "왜 어제 녹음이 없지"를
 * 겪게 된다. 그래서 앱은 아래 사실을 설정 화면에 그대로 적는다.
 *
 * ── Android ─────────────────────────────────────────────
 * 완전 자동이 된다. 포그라운드 서비스로 마이크를 잡고,
 * 백그라운드 태스크가 주기적으로 깨어나 근무 구간을 확인한다.
 * 재부팅 후에도 RECEIVE_BOOT_COMPLETED로 복구된다.
 * 대가: 최소 중요도 알림 하나가 상시 떠 있어야 한다 (OS 요구사항, 우회 불가).
 *
 * ── iOS ─────────────────────────────────────────────────
 * "정해진 시각에 앱을 깨워서 녹음을 시작"하는 것은 **보장되지 않는다.**
 * iOS의 백그라운드 실행은 시스템이 재량으로 주는 것이고, 마이크 세션을
 * 새로 여는 것은 특히 제약이 크다. 두 가지 중 하나를 골라야 한다.
 *
 *   (A) 근무 시작 때 앱을 한 번 연다 (기본값)
 *       한 번 시작하면 오디오 세션이 살아 있는 동안은 화면을 꺼도 계속 녹음된다.
 *       근무 시작 알림을 켜두면 잠금화면에서 탭 한 번으로 시작된다.
 *       (알림 숨김을 켜둔 경우엔 알림도 안 뜨므로 직접 열어야 한다.)
 *
 *   (B) 연속 세션 유지
 *       근무 사이에도 오디오 세션을 놓지 않는다. 완전 자동이 되지만
 *       배터리 소모가 크다. 설정에서 명시적으로 켤 때만 동작한다.
 */

import { Platform } from "react-native";
import {
  DEFAULT_RECORDING_POLICY,
  activeWindowAt,
  createSchedule,
  nextWindowAfter,
  recordingWindows,
  type DutySchedule,
  type RecordingPolicy,
  type RecordingWindow,
} from "@nsr/core";
import {
  createRecording,
  expireRecordings,
  finishRecording,
  getSetting,
  listDutyEntries,
  setSetting,
  totalStorageBytes,
} from "../db";
import { RecordingSession, createExpoAudioBackend } from "./recorder";
import { deleteFile } from "./files";

export const BACKGROUND_TASK_NAME = "nsr-duty-recording-tick";

export const SETTINGS_KEYS = {
  policy: "recording.policy",
  onboarded: "app.onboarded",
  appLock: "security.appLock",
  cloudTranscription: "asr.cloud",
  llmPostEdit: "llm.postEdit",
  discardWithoutSelf: "privacy.discardSegmentsWithoutSelf",
  iosContinuousSession: "recording.iosContinuousSession",
  lastTickAt: "recording.lastTickAt",
} as const;

export async function loadPolicy(): Promise<RecordingPolicy> {
  return getSetting<RecordingPolicy>(SETTINGS_KEYS.policy, DEFAULT_RECORDING_POLICY);
}

export async function savePolicy(policy: RecordingPolicy): Promise<void> {
  await setSetting(SETTINGS_KEYS.policy, policy);
}

export async function loadSchedule(): Promise<DutySchedule> {
  const entries = await listDutyEntries();
  return createSchedule(entries);
}

/** 앞으로 2주치 녹음 구간. 화면 표시와 틱 판정에 함께 쓴다. */
export async function upcomingWindows(now = Date.now()): Promise<RecordingWindow[]> {
  const [schedule, policy] = await Promise.all([loadSchedule(), loadPolicy()]);
  return recordingWindows(schedule, policy, {
    from: now - 24 * 3600_000,
    to: now + 14 * 24 * 3600_000,
  });
}

// 앱 프로세스 안에서 유일한 세션. 두 개가 동시에 마이크를 잡으면 둘 다 실패한다.
let activeSession: RecordingSession | null = null;
let activeShiftId: string | null = null;

export function currentSession(): { session: RecordingSession; shiftId: string } | null {
  return activeSession && activeShiftId
    ? { session: activeSession, shiftId: activeShiftId }
    : null;
}

/**
 * 한 번의 판정. 백그라운드 태스크와 앱 포그라운드 진입 양쪽에서 호출한다.
 *
 * 하는 일:
 *   1. 지금이 녹음 구간인지 확인
 *   2. 구간이면 세션 시작, 아니면 정지
 *   3. 보관기간 지난 파일 정리
 */
export async function tick(now = Date.now()): Promise<{
  recording: boolean;
  window: RecordingWindow | null;
  next: RecordingWindow | null;
}> {
  const policy = await loadPolicy();
  await setSetting(SETTINGS_KEYS.lastTickAt, now);

  const windows = await upcomingWindows(now);
  const window = policy.enabled ? activeWindowAt(windows, now) : null;
  const next = nextWindowAfter(windows, now);

  if (window) {
    if (!activeSession || activeShiftId !== window.shiftId) {
      await stopActive(now);
      await startFor(window, policy, now);
    }
  } else if (activeSession) {
    await stopActive(now);
  }

  await housekeeping(policy, now);

  return { recording: activeSession?.isActive ?? false, window, next };
}

async function startFor(
  window: RecordingWindow,
  policy: RecordingPolicy,
  now: number,
): Promise<void> {
  const backend = createExpoAudioBackend();
  const session = new RecordingSession(backend, policy, window.shiftId, {
    async onChunk(chunk) {
      const id = `${window.shiftId}#${chunk.index}`;
      await createRecording({
        id,
        shiftId: window.shiftId,
        seq: chunk.index,
        startedAt: chunk.startedAt,
      });
      await finishRecording({
        id,
        endedAt: chunk.endedAt,
        durationSec: chunk.durationSec,
        fileUri: chunk.uri,
        sizeBytes: chunk.sizeBytes,
      });
    },
    onError(error) {
      // 녹음 실패는 조용히 넘어가면 안 된다. 사용자는 녹음되고 있다고 믿고 있다.
      console.error("[NSR] 녹음 오류", error);
      void setSetting("recording.lastError", {
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const started = await session.start(now);
  if (started) {
    activeSession = session;
    activeShiftId = window.shiftId;
  }
}

async function stopActive(now: number): Promise<void> {
  if (!activeSession) return;
  await activeSession.stop(now);
  activeSession = null;
  activeShiftId = null;
}

/** 사용자가 화면에서 직접 시작/정지할 때. 듀티표와 무관하게 동작한다. */
export async function startManual(shiftId: string, now = Date.now()): Promise<boolean> {
  const policy = await loadPolicy();
  await stopActive(now);
  await startFor(
    { shiftId, code: "OTHER", label: "수동", date: shiftId.split(":")[0], startAt: now, endAt: now + 12 * 3600_000 },
    policy,
    now,
  );
  return activeSession !== null;
}

export async function stopManual(now = Date.now()): Promise<void> {
  await stopActive(now);
}

/**
 * 보관기간·용량 정리.
 *
 * 오래된 녹음을 안 지우는 것이 이 앱의 가장 큰 개인정보 위험이다.
 * 기기를 잃어버렸을 때 나가는 환자 정보의 양이 여기서 정해진다.
 */
async function housekeeping(policy: RecordingPolicy, now: number): Promise<void> {
  if (policy.retentionDays > 0) {
    const cutoff = now - policy.retentionDays * 24 * 3600_000;
    for (const uri of await expireRecordings(cutoff)) {
      deleteFile(uri);
    }
  }

  const used = await totalStorageBytes();
  if (used > policy.maxStorageMb * 1024 * 1024) {
    // 용량 초과는 사용자에게 알려야 한다. 조용히 지우면 증거가 사라진다.
    await setSetting("recording.storageWarning", { at: now, usedBytes: used });
  }
}

// ────────────────────────────────────────────────────────────
//  백그라운드 태스크 등록
// ────────────────────────────────────────────────────────────

/**
 * 앱 시작 시 한 번 호출한다.
 *
 * 최소 실행 간격은 OS가 정한다(대개 15분). 그래서 근무 시작 직후 몇 분은
 * 놓칠 수 있다. `leadMinutes`를 45분으로 크게 잡아둔 이유가 이것이다 —
 * 틱이 늦어도 인계 시작 전에는 한 번 돌 가능성이 높아진다.
 */
export async function registerBackgroundTask(): Promise<void> {
  const TaskManager = await import("expo-task-manager");
  const BackgroundTask = await import("expo-background-task");

  if (!TaskManager.isTaskDefined(BACKGROUND_TASK_NAME)) {
    TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
      try {
        await tick(Date.now());
        return BackgroundTask.BackgroundTaskResult.Success;
      } catch (error) {
        console.error("[NSR] 백그라운드 틱 실패", error);
        return BackgroundTask.BackgroundTaskResult.Failed;
      }
    });
  }

  const status = await BackgroundTask.getStatusAsync();
  if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
    await setSetting("recording.backgroundRestricted", true);
    return;
  }
  await setSetting("recording.backgroundRestricted", false);
  await BackgroundTask.registerTaskAsync(BACKGROUND_TASK_NAME, {
    minimumInterval: 15,
  });
}

export interface PlatformCapability {
  /** 사용자가 앱을 열지 않아도 근무 시각에 녹음이 시작되는가. */
  fullyAutomatic: boolean;
  /** 사용자에게 보여줄 설명. */
  explanation: string;
}

export function platformCapability(iosContinuousSession: boolean): PlatformCapability {
  if (Platform.OS === "android") {
    return {
      fullyAutomatic: true,
      explanation:
        "근무 시각이 되면 자동으로 녹음이 시작됩니다. Android 규정상 알림 하나가 상시 떠 있어야 하며, " +
        "소리·진동·배너 없이 알림 목록 안쪽에만 표시되도록 설정되어 있습니다. 이 알림은 앱이 끌 수 없습니다.",
    };
  }
  if (iosContinuousSession) {
    return {
      fullyAutomatic: true,
      explanation:
        "연속 세션 유지가 켜져 있어 근무 시각에 자동으로 녹음이 시작됩니다. " +
        "대신 오디오 세션을 계속 붙잡고 있어 배터리 소모가 큽니다.",
    };
  }
  return {
    fullyAutomatic: false,
    explanation:
      "iOS는 정해진 시각에 앱을 깨워 마이크를 새로 여는 것을 보장하지 않습니다. " +
      "근무 시작 때 앱을 한 번 열어주세요. 한 번 시작하면 화면을 꺼도 계속 녹음됩니다. " +
      "완전 자동이 필요하면 설정에서 '연속 세션 유지'를 켤 수 있습니다(배터리 소모 큼).",
  };
}
