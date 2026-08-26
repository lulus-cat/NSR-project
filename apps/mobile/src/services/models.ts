/**
 * 전사 모델 관리 — 내려받고, 고르고, 지운다.
 *
 * 왜 앱이 모델을 직접 받는가
 * ------------------------
 * 앱 번들에 모델을 넣으면 설치 파일이 수백 MB가 된다. 그리고 대부분의 사용자는
 * 그중 하나만 쓴다. 그래서 **필요한 것만 받아서 쓰고, 안 쓰면 지운다.**
 *
 * 정직하게 다뤄야 하는 것들
 * ----------------------
 *  - 파일 크기는 "대략"이다. 실제 크기는 받아 봐야 안다.
 *  - 진행률도 정확하지 않다. 새 expo-file-system 의 다운로드 API 는 진행 콜백을
 *    주지 않아서, 받는 중 파일 크기를 재서 예상 크기로 나눈다. 예상이 틀리면
 *    진행률도 틀린다. 그래서 화면에는 %와 함께 **받은 MB**를 같이 보여준다.
 *  - 속도는 기기마다 몇 배씩 다르다. 남의 폰 숫자를 쓰지 않고, 이 기기에서
 *    한 번 잰 값(`SpeedSample`)만 근거로 삼는다.
 */

import { Directory, File, Paths } from "expo-file-system";
import {
  DEFAULT_MODEL_ID,
  OFFICIAL_MODELS,
  getModel,
  makeCustomModel,
  type AsrModel,
  type CustomModelInput,
  type SpeedSample,
} from "@nsr/core";
import { getSetting, setSetting } from "../db";

const MODELS_DIR = "models";

export const MODEL_KEYS = {
  /** 지금 쓰는 모델 id. */
  activeId: "asr.model.activeId",
  /** 사용자가 직접 추가한 모델들. */
  custom: "asr.model.custom",
  /** 이 기기에서 잰 속도. */
  speedSample: "asr.model.speedSample",
} as const;

function modelsDirectory(): Directory {
  const dir = new Directory(Paths.document, MODELS_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function modelFile(model: AsrModel): File {
  return new File(modelsDirectory(), model.file);
}

// ────────────────────────────────────────────────────────────
//  목록
// ────────────────────────────────────────────────────────────

export interface ModelStatus {
  model: AsrModel;
  installed: boolean;
  /** 실제 파일 크기(MB). 안 받았으면 0. */
  actualSizeMb: number;
  active: boolean;
}

export async function listCustomModels(): Promise<AsrModel[]> {
  return getSetting<AsrModel[]>(MODEL_KEYS.custom, []);
}

export async function activeModelId(): Promise<string> {
  return getSetting<string>(MODEL_KEYS.activeId, DEFAULT_MODEL_ID);
}

/** 화면에 그릴 전체 목록. 공식 모델 + 직접 넣은 모델. */
export async function listModels(): Promise<ModelStatus[]> {
  const [custom, active] = await Promise.all([listCustomModels(), activeModelId()]);
  const all = [...OFFICIAL_MODELS, ...custom];
  return all.map((model) => {
    let installed = false;
    let actualSizeMb = 0;
    try {
      const file = modelFile(model);
      installed = file.exists;
      if (installed) actualSizeMb = Math.round((file.size / (1024 * 1024)) * 10) / 10;
    } catch {
      // 파일 접근이 실패하면 "안 받은 것"으로 본다. 화면이 죽는 것보다 낫다.
    }
    return { model, installed, actualSizeMb, active: model.id === active };
  });
}

/** id 로 찾는다. 공식 목록에 없으면 사용자 모델에서 본다. */
export async function findModel(id: string): Promise<AsrModel | null> {
  const official = getModel(id);
  if (official) return official;
  const custom = await listCustomModels();
  return custom.find((m) => m.id === id) ?? null;
}

/**
 * 지금 쓸 모델의 파일 경로.
 *
 * 고른 모델이 아직 안 받아졌으면 **받아진 것 중에서 대신 쓴다.**
 * 전사를 통째로 실패시키는 것보다, 있는 것으로 돌리고 알려주는 편이 낫다.
 */
export async function resolveModelPath(): Promise<{
  path: string;
  model: AsrModel | null;
  fellBack: boolean;
}> {
  const id = await activeModelId();
  const chosen = await findModel(id);
  if (chosen) {
    const file = modelFile(chosen);
    if (file.exists) return { path: file.uri, model: chosen, fellBack: false };
  }
  const statuses = await listModels();
  const installed = statuses.filter((s) => s.installed);
  if (installed.length > 0) {
    // 받아진 것 중 가장 정확한 쪽(= 가장 느린 쪽)을 고른다.
    installed.sort((a, b) => a.model.relativeSpeed - b.model.relativeSpeed);
    const fallback = installed[0].model;
    return { path: modelFile(fallback).uri, model: fallback, fellBack: true };
  }
  return { path: "", model: chosen, fellBack: false };
}

// ────────────────────────────────────────────────────────────
//  내려받기
// ────────────────────────────────────────────────────────────

export interface DownloadProgress {
  receivedMb: number;
  /** 전체 크기(MB). 서버가 안 알려주면 0. */
  totalMb: number;
  /** 0~1. 전체 크기를 모르면 0이고, 화면에서는 MB만 보여준다. */
  ratio: number;
}

export interface DownloadOutcome {
  ok: boolean;
  sizeMb: number;
  canceled?: boolean;
  error?: string;
}

/** 진행 중인 내려받기. 취소 버튼을 누를 때만 끊는다 — 화면을 나가도 계속된다. */
const inFlight = new Map<string, AbortController>();

export function cancelDownload(modelId: string): void {
  inFlight.get(modelId)?.abort();
}

export function isDownloading(modelId: string): boolean {
  return inFlight.has(modelId);
}

// ── 진행 브로드캐스트 ─────────────────────────────────────────
// 진행 상태를 화면 로컬이 아니라 모듈에 둔다. 화면을 나갔다 와도
// 구독만 다시 걸면 받던 자리부터 그대로 보인다.
const progressMap = new Map<string, DownloadProgress>();
const progressListeners = new Set<(id: string, p: DownloadProgress | null) => void>();

/** 지금 받는 중인 모델들의 진행. 화면이 mount 될 때 복원용으로 읽는다. */
export function activeDownloads(): Record<string, DownloadProgress> {
  return Object.fromEntries(progressMap);
}

/** p 가 null 이면 그 모델의 다운로드가 끝났다는 뜻이다(성공·실패·취소 불문). */
export function subscribeDownloads(
  fn: (modelId: string, p: DownloadProgress | null) => void,
): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

function emitProgress(modelId: string, p: DownloadProgress | null): void {
  if (p) progressMap.set(modelId, p);
  else progressMap.delete(modelId);
  for (const fn of progressListeners) fn(modelId, p);
}

/**
 * 모델을 내려받는다.
 *
 * 200MB~1GB 짜리다. 셀룰러로 받다가 요금이 나가는 일이 없도록 화면에서
 * 크기를 먼저 보여주고 누르게 한다.
 *
 * 서버가 Content-Length 를 안 주면 전체 크기를 모른다(totalBytes = -1).
 * 그때는 %를 지어내지 않고 받은 MB만 보여준다.
 * 중간에 끊기면 반쯤 받은 파일이 남으므로 반드시 지운다 — 남겨두면
 * "설치됨"으로 보이고 전사할 때 정체 모를 오류가 난다.
 */
export async function downloadModel(
  model: AsrModel,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadOutcome> {
  if (!model.url) {
    return {
      ok: false,
      sizeMb: 0,
      error: "다운로드 링크가 없습니다. 모델 파일을 직접 넣어주십시오.",
    };
  }
  if (inFlight.has(model.id)) {
    return { ok: false, sizeMb: 0, error: "이미 다운로드 중입니다." };
  }

  const dir = modelsDirectory();
  const target = new File(dir, model.file);
  const controller = new AbortController();
  inFlight.set(model.id, controller);

  const MB = 1024 * 1024;
  const round = (n: number) => Math.round(n * 10) / 10;
  const notifId = `nsr-model-${model.id}`;
  const { ensureNotifPermission, notifyDone, notifyProgress } = await import("./progress-notify");
  await ensureNotifPermission();
  emitProgress(model.id, { receivedMb: 0, totalMb: 0, ratio: 0 });

  try {
    // 허깅페이스에서 받을 때 내장 토큰이 있으면 붙인다 — 익명 다운로드가
    // 429/401 로 막히는 경우의 우회로다. 다른 호스트에는 토큰을 보내지 않는다.
    const { BUILT_IN } = await import("../config");
    const hf = BUILT_IN.huggingFaceToken && /https:\/\/(.+\.)?huggingface\.co\//.test(model.url);
    await File.downloadFileAsync(model.url, target, {
      idempotent: true,
      headers: hf ? { Authorization: `Bearer ${BUILT_IN.huggingFaceToken}` } : undefined,
      signal: controller.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        const p: DownloadProgress = {
          receivedMb: round(bytesWritten / MB),
          totalMb: totalBytes > 0 ? round(totalBytes / MB) : 0,
          ratio: totalBytes > 0 ? Math.min(bytesWritten / totalBytes, 1) : 0,
        };
        onProgress?.(p);
        emitProgress(model.id, p);
        const pct = Math.round(p.ratio * 100);
        void notifyProgress(
          notifId,
          pct,
          p.totalMb > 0 ? `모델 받는 중 ${pct}%` : "모델 받는 중",
          `${model.name} · ${p.receivedMb}${p.totalMb > 0 ? ` / ${p.totalMb}` : ""} MB · 화면을 닫아도 계속됩니다`,
        );
      },
    });

    const done = new File(dir, model.file);
    if (!done.exists || done.size === 0) {
      deleteModelFile(model);
      await notifyDone(notifId, "모델 받기 실패", "받은 파일이 온전하지 않습니다. 다시 받아 주십시오.");
      return { ok: false, sizeMb: 0, error: "다운로드된 파일이 온전하지 않습니다. 지우고 다시 받아 주십시오." };
    }
    const sizeMb = round(done.size / MB);
    onProgress?.({ receivedMb: sizeMb, totalMb: sizeMb, ratio: 1 });
    await notifyDone(notifId, "모델 받기 완료", `${model.name} · ${sizeMb} MB`);
    return { ok: true, sizeMb };
  } catch (error) {
    // 성공하지 못한 파일은 어떤 이유였든 남기지 않는다.
    deleteModelFile(model);
    if (controller.signal.aborted) {
      try {
        const Notifications = await import("expo-notifications");
        await Notifications.dismissNotificationAsync(notifId);
      } catch {
        // 알림이 없으면 그만이다.
      }
      return { ok: false, sizeMb: 0, canceled: true };
    }
    const raw = error instanceof Error ? error.message : "다운로드에 실패했습니다.";
    // 원시 오류("FileSystem.downloadFileAsync has been rejected ... 404")는
    // 사람이 읽을 문장이 아니다. 흔한 경우만 우리말로 옮긴다.
    const friendly = /\b404\b/.test(raw)
      ? "파일을 받지 못했습니다 (404). GitHub 저장소가 비공개 상태면 앱이 모델을 받을 수 없습니다 — 저장소를 공개로 전환하거나 개발자에게 알려주십시오."
      : /Network|ENOTFOUND|ECONN|timeout/i.test(raw)
        ? "인터넷이 끊겼습니다. Wi-Fi 상태를 확인하고 다시 시도하십시오."
        : raw;
    await notifyDone(notifId, "모델 받기 실패", friendly);
    return { ok: false, sizeMb: 0, error: friendly };
  } finally {
    inFlight.delete(model.id);
    emitProgress(model.id, null);
  }
}

export function deleteModelFile(model: AsrModel): void {
  try {
    const file = modelFile(model);
    if (file.exists) file.delete();
  } catch {
    // 없으면 지울 것도 없다.
  }
}

export async function setActiveModel(id: string): Promise<void> {
  await setSetting(MODEL_KEYS.activeId, id);
}

// ────────────────────────────────────────────────────────────
//  직접 넣은 모델
// ────────────────────────────────────────────────────────────

export async function addCustomModel(
  input: CustomModelInput,
): Promise<{ ok: boolean; error?: string }> {
  const { model, error } = makeCustomModel(input);
  if (!model) return { ok: false, error };
  const custom = await listCustomModels();
  if (custom.some((m) => m.id === model.id) || getModel(model.id)) {
    return { ok: false, error: "같은 파일 이름의 모델이 이미 있습니다." };
  }
  await setSetting(MODEL_KEYS.custom, [...custom, model]);
  return { ok: true };
}

export async function removeCustomModel(id: string): Promise<void> {
  const custom = await listCustomModels();
  const target = custom.find((m) => m.id === id);
  if (target) deleteModelFile(target);
  await setSetting(
    MODEL_KEYS.custom,
    custom.filter((m) => m.id !== id),
  );
  if ((await activeModelId()) === id) await setActiveModel(DEFAULT_MODEL_ID);
}

// ────────────────────────────────────────────────────────────
//  속도 측정
// ────────────────────────────────────────────────────────────

export async function loadSpeedSample(): Promise<SpeedSample | undefined> {
  const sample = await getSetting<SpeedSample | null>(MODEL_KEYS.speedSample, null);
  return sample ?? undefined;
}

/**
 * 실제 전사에서 잰 속도를 남긴다.
 *
 * 별도의 벤치마크를 돌리지 않는다. 어차피 매번 전사를 하니까 그때 재면 된다.
 * 벤치마크용 오디오를 따로 돌리는 것은 배터리만 쓴다.
 */
export async function recordSpeedSample(input: {
  modelId: string;
  audioSeconds: number;
  elapsedSeconds: number;
}): Promise<void> {
  if (input.audioSeconds <= 0 || input.elapsedSeconds <= 0) return;
  // 너무 짧은 구간은 모델 적재 시간에 묻혀 값이 왜곡된다.
  if (input.audioSeconds < 30) return;
  await setSetting(MODEL_KEYS.speedSample, {
    modelId: input.modelId,
    secondsPerAudioSecond: input.elapsedSeconds / input.audioSeconds,
  } satisfies SpeedSample);
}
