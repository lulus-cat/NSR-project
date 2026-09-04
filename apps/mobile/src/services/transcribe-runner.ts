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

import { setRecordingState, setSetting, type RecordingRow } from "../db";
import { processRecording, resolveProvider } from "./asr";
import { logDebug } from "./debug";
import { beginWork, notifyDone, notifyProgress } from "./progress-notify";

export interface RunnerState {
  running: boolean;
  shiftId: string | null;
  /** 지금 몇 번째 파일인가 (1부터). */
  fileIndex: number;
  fileCount: number;
  /** 지금 돌리는 기록의 id — 화면이 파일별 배지를 이걸로 맞춘다. */
  fileId: string | null;
  /** 지금 파일 기준 0~100. */
  filePercent: number;
  /** 전체 작업 기준 0~100. */
  percent: number;
  /** %가 안 움직이는 이유(서버가 모델 준비 중 등). 움직이기 시작하면 지워진다. */
  note: string | null;
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
  fileId: null,
  filePercent: 0,
  percent: 0,
  note: null,
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
    fileId: files[0]?.id ?? null,
    filePercent: 0,
    percent: 0,
    note: null,
    error: null,
  });

  void (async () => {
    // 포그라운드 서비스를 잡는다 — 다른 앱으로 넘어가도 얼리지 않게.
    // notifyDone(성공·실패 공통)이 endWork 라서 여기와 짝이 맞는다.
    await beginWork("바꿀 준비 중", "화면을 꺼도 계속돼요");
    // 캐시 정리 등으로 파일이 사라진 기록은 건너뛰고 마지막에 알린다.
    let missing = 0;
    try {
      const { File } = await import("expo-file-system");
      const provider = await resolveProvider();
      let sentenceTotal = 0;
      for (let i = 0; i < files.length; i++) {
        const rec = files[i];
        emit({
          fileIndex: i + 1,
          fileId: rec.id,
          filePercent: 0,
          percent: Math.round((i / files.length) * 100),
        });
        if (!rec.file_uri || !new File(rec.file_uri).exists) {
          missing += 1;
          await setRecordingState(rec.id, "discarded", "폰 용량이 없어 파일이 사라졌어요");
          continue;
        }
        await notifyProgress(
          NOTIF_ID,
          state.percent,
          `바꾸는 중 ${state.percent}%`,
          `파일 ${i + 1}/${files.length} · 화면을 꺼도 계속돼요`,
        );
        sentenceTotal += await processRecording(rec, provider, (filePct, note) => {
          const overall = Math.round(((i + filePct / 100) / files.length) * 100);
          const mine = Math.round(Math.max(0, Math.min(100, filePct)));
          if (
            overall !== state.percent ||
            mine !== state.filePercent ||
            (note ?? null) !== state.note
          ) {
            emit({ percent: overall, filePercent: mine, note: note ?? null });
            void notifyProgress(
              NOTIF_ID,
              overall,
              `바꾸는 중 ${overall}%`,
              note ?? `파일 ${i + 1}/${files.length} · 화면을 꺼도 계속돼요`,
            );
          }
        });
      }
      const doneCount = files.length - missing;
      const summary =
        missing > 0
          ? `녹음 ${doneCount}건을 글자로 바꿨어요 · ${missing}건은 파일이 없어 건너뛰었어요`
          : `녹음 ${doneCount}건을 글자로 바꿨어요.`;
      // 앱 안 알림 — 홈의 기록 폴더가 이 값을 읽어 '새 전사 결과'를 띄운다.
      // 전사 결과 화면을 열면 seen 이 된다.
      await setSetting("transcribe.lastResult", {
        shiftId,
        sentences: sentenceTotal,
        at: Date.now(),
        seen: false,
      });
      emit({
        running: false,
        percent: 100,
        fileId: null,
        note: null,
        error: missing > 0 ? `${missing}건은 파일이 없어 건너뛰었어요.` : null,
        completedAt: Date.now(),
      });
      await notifyDone(NOTIF_ID, "글자로 다 바꿨어요", summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "글자로 바꾸지 못했어요. 다시 해 주세요.";
      void logDebug(`전사 실패: ${msg}`);
      emit({ running: false, fileId: null, note: null, error: msg, completedAt: Date.now() });
      await notifyDone(NOTIF_ID, "바꾸다 멈췄어요", msg);
    }
  })();

  return true;
}
