/**
 * 전사 러너 — 전사를 화면이 아니라 여기서 돌린다.
 *
 * 전에는 근무 기록 화면의 버튼 핸들러가 루프를 돌았다. 화면을 벗어나면
 * 진행을 볼 수 없고, 오류는 사라지고, 사용자는 "중단됐다"고 느낀다.
 * 러너는 모듈 스코프 싱글턴이라 화면 이동과 무관하게 끝까지 돌고,
 * 어느 화면이든 구독으로 진행률을 읽는다.
 *
 * 상태바 알림: 작업 동안 포그라운드 서비스(beginWork)를 잡는다. 서비스
 * 알림이 곧 진행 표시고, 잡고 있는 동안은 다른 앱으로 넘어가도 시스템이
 * 프로세스를 얼리지 않는다(9차 ①의 원인이 이 얼리기였다).
 *
 * 한계(정직): 사용자가 앱을 최근 목록에서 밀어 없애면 서비스째 죽는다.
 * 그때 남은 파일은 '전사할 기록'으로 되돌아온다.
 */

import { setRecordingState, type RecordingRow } from "../db";
import { processRecording, resolveProvider } from "./asr";
import { logDebug } from "./debug";
import { beginWork, notifyDone, notifyProgress } from "./progress-notify";

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

/**
 * 전사 작업을 시작한다. 이미 돌고 있으면 무시한다(한 번에 하나).
 * 돌아오는 Promise 를 기다릴 필요 없다 — 진행은 구독으로 본다.
 */
export function startTranscription(shiftId: string, recordings: RecordingRow[]): boolean {
  if (state.running) return false;
  const files = recordings.filter((r) => r.state === "recorded" && r.file_uri);
  if (files.length === 0) return false;

  emit({
    running: true,
    shiftId,
    fileIndex: 1,
    fileCount: files.length,
    percent: 0,
    error: null,
  });

  void (async () => {
    // 포그라운드 서비스를 잡는다 — 다른 앱으로 넘어가도 얼리지 않게.
    // notifyDone(성공·실패 공통)이 endWork 라서 여기와 짝이 맞는다.
    await beginWork("전사 준비 중", "화면을 닫아도 계속됩니다");
    // 캐시 정리 등으로 파일이 사라진 기록은 건너뛰고 마지막에 알린다.
    let missing = 0;
    try {
      const { File } = await import("expo-file-system");
      const provider = await resolveProvider();
      for (let i = 0; i < files.length; i++) {
        const rec = files[i];
        emit({ fileIndex: i + 1, percent: Math.round((i / files.length) * 100) });
        if (!rec.file_uri || !new File(rec.file_uri).exists) {
          missing += 1;
          await setRecordingState(rec.id, "discarded", "파일이 기기 저장 공간 정리로 사라짐");
          continue;
        }
        await notifyProgress(
          NOTIF_ID,
          state.percent,
          `전사 중 ${state.percent}%`,
          `파일 ${i + 1}/${files.length} · 화면을 닫아도 계속됩니다`,
        );
        await processRecording(rec, provider, (filePct) => {
          const overall = Math.round(((i + filePct / 100) / files.length) * 100);
          if (overall !== state.percent) {
            emit({ percent: overall });
            void notifyProgress(
              NOTIF_ID,
              overall,
              `전사 중 ${overall}%`,
              `파일 ${i + 1}/${files.length} · 화면을 닫아도 계속됩니다`,
            );
          }
        });
      }
      const doneCount = files.length - missing;
      const summary =
        missing > 0
          ? `기록 ${doneCount}건 전사 완료 · ${missing}건은 파일이 사라져 건너뜀`
          : `기록 ${doneCount}건을 전사했습니다.`;
      emit({
        running: false,
        percent: 100,
        error: missing > 0 ? `${missing}건은 파일이 저장 공간 정리로 사라져 건너뛰었습니다.` : null,
        completedAt: Date.now(),
      });
      await notifyDone(NOTIF_ID, "전사 완료", summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "전사에 실패했습니다.";
      void logDebug(`전사 실패: ${msg}`);
      emit({ running: false, error: msg, completedAt: Date.now() });
      await notifyDone(NOTIF_ID, "전사 중단", msg);
    }
  })();

  return true;
}
