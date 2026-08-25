/**
 * 기존 오디오 파일 가져오기 — 다른 앱(다글로·기본 음성 메모 등)으로 만든
 * 파일을 골라 이 앱의 기록으로 등록한다. 등록되면 그다음은 평소와 같다:
 * 근무 기록 화면에서 전사 → 교정 → 카드·보고서.
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { toDateString } from "@nsr/core";
import { createRecording, finishRecording } from "../db";
import { recordingsDirectory } from "./files";

export async function importAudioFile(): Promise<{
  ok: boolean;
  shiftId?: string;
  message: string;
}> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: "audio/*",
    copyToCacheDirectory: true,
  });
  if (picked.canceled || !picked.assets?.[0]) {
    return { ok: false, message: "취소했습니다." };
  }
  const asset = picked.assets[0];

  const date = toDateString(Date.now());
  const shiftId = `${date}:IMPORT`;
  const id = `imp-${Date.now()}`;
  const ext = (asset.name?.split(".").pop() ?? "m4a").toLowerCase();
  const target = new File(recordingsDirectory(), `${id}.${ext}`);
  new File(asset.uri).copy(target);

  const now = Date.now();
  await createRecording({ id, shiftId, seq: 0, startedAt: now });
  await finishRecording({
    id,
    endedAt: now,
    // 길이를 모른다 — 전사할 때 실제 오디오 길이가 확정된다. 0 은 "미확인"이다.
    durationSec: 0,
    fileUri: target.uri,
    sizeBytes: asset.size ?? target.size ?? 0,
  });
  return {
    ok: true,
    shiftId,
    message: "가져왔습니다. 근무 기록에서 전사를 실행하십시오.",
  };
}
