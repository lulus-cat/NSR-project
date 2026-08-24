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

/** 진행 중인 내려받기. 화면을 나가거나 취소를 누르면 끊는다. */
const inFlight = new Map<string, AbortController>();

export function cancelDownload(modelId: string): void {
  inFlight.get(modelId)?.abort();
}

export function isDownloading(modelId: string): boolean {
  return inFlight.has(modelId);
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
      error: "받을 주소가 없는 모델입니다. 파일을 직접 넣어 주세요.",
    };
  }
  if (inFlight.has(model.id)) {
    return { ok: false, sizeMb: 0, error: "이미 받고 있습니다." };
  }

  const dir = modelsDirectory();
  const target = new File(dir, model.file);
  const controller = new AbortController();
  inFlight.set(model.id, controller);

  const MB = 1024 * 1024;
  const round = (n: number) => Math.round(n * 10) / 10;

  try {
    await File.downloadFileAsync(model.url, target, {
      idempotent: true,
      signal: controller.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        onProgress?.({
          receivedMb: round(bytesWritten / MB),
          totalMb: totalBytes > 0 ? round(totalBytes / MB) : 0,
          ratio: totalBytes > 0 ? Math.min(bytesWritten / totalBytes, 1) : 0,
        });
      },
    });

    const done = new File(dir, model.file);
    if (!done.exists || done.size === 0) {
      deleteModelFile(model);
      return { ok: false, sizeMb: 0, error: "파일이 비어 있습니다. 다시 받아 주세요." };
    }
    const sizeMb = round(done.size / MB);
    onProgress?.({ receivedMb: sizeMb, totalMb: sizeMb, ratio: 1 });
    return { ok: true, sizeMb };
  } catch (error) {
    // 성공하지 못한 파일은 어떤 이유였든 남기지 않는다.
    deleteModelFile(model);
    if (controller.signal.aborted) {
      return { ok: false, sizeMb: 0, canceled: true };
    }
    return {
      ok: false,
      sizeMb: 0,
      error: error instanceof Error ? error.message : "내려받기에 실패했습니다.",
    };
  } finally {
    inFlight.delete(model.id);
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
