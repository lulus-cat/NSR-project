/**
 * 기존 오디오 파일 가져오기 — 다른 앱(다글로·기본 음성 메모 등)으로 만든
 * 파일을 이 앱의 기록으로 등록한다. 등록되면 그다음은 평소와 같다:
 * 근무 기록 화면에서 전사 → 교정 → 카드·보고서.
 *
 * 두 단계다. 고르기(pickAudioFiles)는 파일 선택창만 열고, 등록
 * (registerImportedAudio)은 화면(app/import-audio.tsx)에서 근무 날짜·듀티와
 * 합치기/따로를 정한 뒤에 부른다. 예전에는 고르자마자 '오늘:IMPORT' 근무에
 * 자동으로 붙였는데, 어제 녹음을 오늘 올리면 엉뚱한 날의 기록이 됐다.
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { DEFAULT_TEMPLATES, type ShiftCode } from "@nsr/core";
import { createRecording, finishRecording, listRecordings } from "../db";
import { recordingsDirectory } from "./files";

export interface PickedAudio {
  uri: string;
  name: string;
  size: number;
}

/** 파일 선택창. 여러 개를 한 번에 고를 수 있다. 취소하면 빈 배열. */
export async function pickAudioFiles(): Promise<PickedAudio[]> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: "audio/*",
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (picked.canceled || !picked.assets) return [];
  return picked.assets.map((a, i) => ({
    uri: a.uri,
    name: a.name?.trim() || `음성 ${i + 1}`,
    size: a.size ?? 0,
  }));
}

/** 근무 시작 시각(epoch ms) — 듀티 템플릿의 시작 시간. 시간이 없는 듀티는 09:00. */
function shiftStartMs(date: string, code: ShiftCode): number {
  const start = DEFAULT_TEMPLATES[code]?.startTime || "09:00";
  const [h, m] = start.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(y, mo - 1, d, h || 0, m || 0).getTime();
}

function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? m[1].toLowerCase() : "m4a";
}

/**
 * 고른 파일들을 근무의 기록으로 등록한다. 파일은 앱 저장소로 복사된다.
 *
 * 순번(seq)은 그 근무에 이미 있는 기록 뒤에 이어 붙인다. 시작 시각은
 * 근무 시작 + 순번(초) — 실제 녹음 시각은 모르지만, 목록이 고른 차례대로 선다.
 */
export async function registerImportedAudio(input: {
  files: PickedAudio[];
  date: string;
  code: ShiftCode;
  /** 참이면 파일마다 따로 본다. 거짓이면 같은 근무의 기록과 한 전사본으로 합친다. */
  separate: boolean;
}): Promise<{ shiftId: string; ids: string[] }> {
  const shiftId = `${input.date}:${input.code}`;
  const existing = await listRecordings(shiftId);
  let seq = existing.reduce((max, r) => Math.max(max, r.seq), -1) + 1;
  const base = shiftStartMs(input.date, input.code);
  const stamp = Date.now();
  const ids: string[] = [];
  for (const [i, f] of input.files.entries()) {
    const id = `imp-${stamp}-${i}`;
    const target = new File(recordingsDirectory(), `${id}.${extensionOf(f.name)}`);
    new File(f.uri).copy(target);
    const startedAt = base + seq * 1000;
    await createRecording({
      id,
      shiftId,
      seq,
      startedAt,
      label: f.name,
      separate: input.separate,
    });
    await finishRecording({
      id,
      endedAt: startedAt,
      // 길이를 모른다 — 전사할 때 실제 오디오 길이가 확정된다. 0 은 "미확인"이다.
      durationSec: 0,
      fileUri: target.uri,
      sizeBytes: f.size || target.size || 0,
    });
    ids.push(id);
    seq += 1;
  }
  return { shiftId, ids };
}
