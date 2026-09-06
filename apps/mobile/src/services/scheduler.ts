/**
 * 듀티표 기반 자동 기록 스케줄러.
 *
 * 플랫폼별로 되는 정도가 다르다. 이걸 숨기면 사용자는 "왜 어제 기록이 없지"를
 * 겪게 된다. 그래서 앱은 아래 사실을 설정 화면에 그대로 적는다.
 *
 * ── Android ─────────────────────────────────────────────
 * 완전 자동이 된다. 포그라운드 서비스로 마이크를 잡고,
 * 백그라운드 태스크가 주기적으로 깨어나 근무 구간을 확인한다.
 * 재부팅 후에도 RECEIVE_BOOT_COMPLETED로 복구된다.
 * 대가: 최소 중요도 알림 하나가 상시 떠 있어야 한다 (OS 요구사항, 우회 불가).
 *
 * ── iOS ─────────────────────────────────────────────────
 * "정해진 시각에 앱을 깨워서 기록을 시작"하는 것은 **보장되지 않는다.**
 * iOS의 백그라운드 실행은 시스템이 재량으로 주는 것이고, 마이크 세션을
 * 새로 여는 것은 특히 제약이 크다. 두 가지 중 하나를 골라야 한다.
 *
 *   (A) 근무 시작 때 앱을 한 번 연다 (기본값)
 *       한 번 시작하면 오디오 세션이 살아 있는 동안은 화면을 꺼도 계속 기록된다.
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
  DEFAULT_TEMPLATES,
  activeWindowAt,
  createSchedule,
  nextWindowAfter,
  recordingWindows,
  type DutyEntry,
  type DutySchedule,
  type RecordingOwner,
  type RecordingPolicy,
  type RecordingWindow,
  type SessionState,
  MANUAL_MAX_MS,
  geoDecision,
  tickDecision,
  type ShiftCode,
  type ShiftTemplate,
} from "@nsr/core";
import {
  createRecording,
  expireRecordings,
  finishRecording,
  getRecording,
  getSetting,
  listAllRecordingFiles,
  listDutyEntries,
  listRecordings,
  setSetting,
  totalStorageBytes,
} from "../db";
import { RecordingSession, createExpoAudioBackend } from "./recorder";
import { deleteFile, orphanRecordings } from "./files";

export const BACKGROUND_TASK_NAME = "nsr-duty-recording-tick";

export const SETTINGS_KEYS = {
  policy: "recording.policy",
  onboarded: "app.onboarded",
  appLock: "security.appLock",
  discardWithoutSelf: "privacy.discardSegmentsWithoutSelf",
  iosContinuousSession: "recording.iosContinuousSession",
  lastTickAt: "recording.lastTickAt",
  dutyTemplates: "duty.templateOverrides",
} as const;

/** 듀티 화면에서 편집하는 코드별 근무 시간 덮어쓰기. */
export type DutyTemplateOverride = Partial<
  Pick<ShiftTemplate, "startTime" | "endTime" | "preHandoverMin" | "postHandoverMin">
>;

export async function loadDutyTemplates(): Promise<Record<ShiftCode, ShiftTemplate>> {
  const overrides = await getSetting<Partial<Record<ShiftCode, DutyTemplateOverride>>>(
    SETTINGS_KEYS.dutyTemplates,
    {},
  );
  const merged = { ...DEFAULT_TEMPLATES };
  for (const [code, o] of Object.entries(overrides)) {
    const base = merged[code as ShiftCode];
    if (base && o) merged[code as ShiftCode] = { ...base, ...o };
  }
  return merged;
}

export async function saveDutyTemplateOverride(
  code: ShiftCode,
  override: DutyTemplateOverride,
): Promise<void> {
  const overrides = await getSetting<Partial<Record<ShiftCode, DutyTemplateOverride>>>(
    SETTINGS_KEYS.dutyTemplates,
    {},
  );
  await setSetting(SETTINGS_KEYS.dutyTemplates, {
    ...overrides,
    [code]: { ...overrides[code], ...override },
  });
}

/**
 * 사용자 근무 시간이 반영된 듀티표를 만든다. **화면과 판정이 같은 시간을
 * 봐야 하므로**, 앱에서 createSchedule 을 직접 부르지 말고 이걸 쓴다.
 */
export async function buildSchedule(entries?: DutyEntry[]): Promise<DutySchedule> {
  const list = entries ?? (await listDutyEntries());
  return createSchedule(list, await loadDutyTemplates());
}

export async function loadPolicy(): Promise<RecordingPolicy> {
  return getSetting<RecordingPolicy>(SETTINGS_KEYS.policy, DEFAULT_RECORDING_POLICY);
}

export async function savePolicy(policy: RecordingPolicy): Promise<void> {
  await setSetting(SETTINGS_KEYS.policy, policy);
}

export async function loadSchedule(): Promise<DutySchedule> {
  return buildSchedule();
}

/** 앞으로 2주치 기록 구간. 화면 표시와 틱 판정에 함께 쓴다. */
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
/** 이 기록을 켠 주체. 끄는 권한이 여기서 갈린다 (@nsr/core 의 규칙). */
let activeOwner: RecordingOwner = "tick";
let activeStartedAt = 0;

/**
 * 시작·정지가 겹치지 않게 줄을 세운다.
 *
 * tick 은 백그라운드 태스크·화면 복귀·정책 변경 세 곳에서 불리고, 지오펜스는
 * 그와 무관하게 또 부른다. 둘이 겹치면 둘 다 "지금 세션이 없네" 를 보고 각자
 * 마이크를 잡는다 — 같은 이름의 조각 파일을 둘이 쓰고, 하나는 주인 없이 남아
 * 타이머만 돈다. 그 사고를 막는 것이 이 한 줄이다.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

/** 지금 세션의 상태 — core 의 판단 함수가 받는 모양 그대로. */
export function sessionOwner(): SessionState | null {
  return sessionState();
}

function sessionState(): SessionState | null {
  if (!activeSession || !activeShiftId) return null;
  return {
    owner: activeOwner,
    shiftId: activeShiftId,
    startedAt: activeStartedAt,
    alive: activeSession.isActive,
  };
}

/**
 * 한 번의 판정. 백그라운드 태스크와 앱 포그라운드 진입 양쪽에서 호출한다.
 *
 * 하는 일:
 *   1. 지금이 기록 구간인지 확인
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

  await serialize(async () => {
    const act = tickDecision({
      session: sessionState(),
      windowShiftId: window?.shiftId ?? null,
      now,
    });
    if (act.do === "stop") {
      await stopActive(now);
    } else if (act.do === "start") {
      await stopActive(now);
      await startFor(windowFor(act.shiftId, now, window), policy, now, act.owner);
    } else if (act.do === "revive") {
      // 세션은 남아 있는데 마이크가 죽었다. 껐다가 같은 근무·같은 주인으로 다시.
      await stopActive(now);
      await startFor(windowFor(act.shiftId, now, window), policy, now, act.owner);
    }
  });

  // 위치로 한 번 더 맞춘다. 안드로이드는 지오펜스 진입·이탈 신호를 심심찮게
  // 빠뜨린다 — 그때 기록이 안 켜지거나, 퇴근했는데 계속 켜져 있다.
  // (지오펜스가 스케줄러를 부르므로 여기서는 늦게 불러 순환 참조를 피한다.)
  try {
    const { syncByLocation } = await import("./geofence");
    await syncByLocation(now);
  } catch (e) {
    // 위치를 못 읽는 것은 흔하다(실내·권한). 다만 조용히 삼키지는 않는다.
    void setSetting("recording.lastGeoError", {
      at: now,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  await housekeeping(policy, now);

  return { recording: activeSession?.isActive ?? false, window, next };
}

/** 근무 id 로 기록 구간 하나를 만든다. 진짜 구간이 있으면 그것을 그대로 쓴다. */
function windowFor(shiftId: string, now: number, real: RecordingWindow | null): RecordingWindow {
  if (real && real.shiftId === shiftId) return real;
  return {
    shiftId,
    code: "OTHER",
    label: "이어서 기록",
    date: shiftId.split(":")[0],
    startAt: now,
    endAt: now + MANUAL_MAX_MS,
  };
}

async function startFor(
  window: RecordingWindow,
  policy: RecordingPolicy,
  now: number,
  owner: RecordingOwner,
): Promise<void> {
  // 이 근무에 이미 있는 조각 다음 번호부터. 0 에서 다시 세면 앞 파일을 덮는다.
  const existing = await listRecordings(window.shiftId);
  const startIndex = existing.reduce((max, r) => Math.max(max, r.seq), -1) + 1;

  const backend = createExpoAudioBackend();
  const session = new RecordingSession(backend, policy, window.shiftId, {
    // 조각을 **열 때** 줄을 만든다. 닫을 때 만들면, 앱이 그사이에 죽었을 때
    // 파일만 남고 줄이 없어 다음 조각이 같은 번호를 써서 그 파일을 덮는다.
    async onChunkStart(index, startedAt) {
      await createRecording({
        id: `${window.shiftId}#${index}`,
        shiftId: window.shiftId,
        seq: index,
        startedAt,
      });
    },
    async onChunk(chunk) {
      const id = `${window.shiftId}#${chunk.index}`;
      await finishRecording({
        id,
        endedAt: chunk.endedAt,
        durationSec: chunk.durationSec,
        fileUri: chunk.uri,
        sizeBytes: chunk.sizeBytes,
      });
    },
    onEmptyChunk(chunk) {
      // 소리 없이 마이크를 뺏기는 길이 있다 — 전화가 오거나, 다른 앱이 가져가거나,
      // OS 가 권한을 거둘 때. 그러면 상태는 '기록 중'인데 파일만 0바이트로 쌓인다.
      // 크기를 보고 알아채서 다음 tick 이 되살리게 한다.
      void setSetting("recording.lastError", {
        at: Date.now(),
        message: `${Math.round(chunk.durationSec)}초짜리 빈 파일이 나왔어요. 마이크를 다른 앱이 쓰고 있는지 봐 주세요.`,
      });
    },
    onError(error) {
      // 기록 실패는 조용히 넘어가면 안 된다. 사용자는 기록되고 있다고 믿고 있다.
      console.error("[NSR] 듀티 자동 기록 실패", error);
      void setSetting("recording.lastError", {
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      });
    },
  }, startIndex);

  const started = await session.start(now);
  if (started) {
    activeSession = session;
    activeShiftId = window.shiftId;
    activeOwner = owner;
    activeStartedAt = now;
  }
  // 실패하면 아무것도 안 남긴다. 예전에는 '수동으로 켰음' 표시만 남아서,
  // 그 뒤로 듀티 자동 기록이 영영 안 켜졌다 (세션은 없는데 표시는 있었다).
}

async function stopActive(now: number): Promise<void> {
  activeOwner = "tick";
  activeStartedAt = 0;
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  activeShiftId = null;
  await session.stop(now);
}

/**
 * 화면 버튼과 지오펜스가 쓰는 시작·정지.
 *
 * `owner` 가 곧 이 기록을 끌 수 있는 사람이다 — 홈 버튼으로 켠 기록("user")은
 * 위치 판정도 듀티표 판정도 못 끈다. 병원 밖에서 인계를 녹음하는 경우가 그렇다.
 */
export async function startManual(
  shiftId: string,
  now = Date.now(),
  owner: RecordingOwner = "user",
): Promise<boolean> {
  return serialize(async () => {
    const policy = await loadPolicy();
    await stopActive(now);
    await startFor(
      { shiftId, code: "OTHER", label: "직접 켠 기록", date: shiftId.split(":")[0], startAt: now, endAt: now + MANUAL_MAX_MS },
      policy,
      now,
      owner,
    );
    return activeSession?.isActive === true;
  });
}

export async function stopManual(now = Date.now()): Promise<void> {
  await serialize(() => stopActive(now));
}

/**
 * 보관기간·용량 정리.
 *
 * 오래된 기록을 안 지우는 것이 이 앱의 가장 큰 개인정보 위험이다.
 * 기기를 잃어버렸을 때 나가는 환자 정보의 양이 여기서 정해진다.
 */
async function housekeeping(policy: RecordingPolicy, now: number): Promise<void> {
  if (policy.retentionDays > 0) {
    const cutoff = now - policy.retentionDays * 24 * 3600_000;
    for (const uri of await expireRecordings(cutoff)) {
      deleteFile(uri);
    }
  }

  // 파일은 있는데 줄이 없는 녹음을 되찾는다. 그런 파일은 화면에 안 보이고
  // 용량에도 안 잡히고 지워지지도 않아서, 폰에만 조용히 쌓인다.
  try {
    const known = (await listAllRecordingFiles()).filter((u): u is string => !!u);
    for (const found of orphanRecordings(known)) {
      const id = `${found.shiftId}#되찾음${found.seq}`;
      if (await getRecording(id)) continue;
      await createRecording({ id, shiftId: found.shiftId, seq: found.seq, startedAt: now });
      await finishRecording({
        id,
        endedAt: now,
        durationSec: 0,
        fileUri: found.uri,
        sizeBytes: 0,
      });
      void setSetting("recording.recovered", { at: now, shiftId: found.shiftId });
    }
  } catch {
    // 되찾기는 덤이다. 실패해도 나머지 정리는 돈다.
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
        console.error("[NSR] 백그라운드 확인 실패", error);
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
  /** 사용자가 앱을 열지 않아도 근무 시각에 기록이 시작되는가. */
  fullyAutomatic: boolean;
  /** 사용자에게 보여줄 설명. */
  explanation: string;
}

export function platformCapability(iosContinuousSession: boolean): PlatformCapability {
  if (Platform.OS === "android") {
    return {
      fullyAutomatic: true,
      explanation:
        "출근 시간에 맞춰 기록이 저절로 켜져요. 대신 알림이 계속 떠 있어요. " +
        "소리도 진동도 없는 알림이고, 안드로이드 규칙이라 끌 수 없어요.",
    };
  }
  if (iosContinuousSession) {
    return {
      fullyAutomatic: true,
      explanation:
        "'백그라운드 상시 대기'가 켜져 있어 출근 시간에 저절로 기록해요. " +
        "대신 배터리를 조금 더 써요.",
    };
  }
  return {
    fullyAutomatic: false,
    explanation:
      "아이폰은 앱을 열어 두지 않으면 마이크가 저절로 켜지지 않을 수 있어요. " +
      "인계 직전에 앱을 한 번 열어 주세요. 한 번 켜진 기록은 화면을 꺼도 이어져요. " +
      "저절로 켜지게 하려면 설정에서 '백그라운드 상시 대기'를 켜요.",
  };
}
