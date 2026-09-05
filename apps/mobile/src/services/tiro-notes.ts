/**
 * 티로 노트 가져오기 — 티로 앱으로 녹음해 이미 전사된 노트를 이 앱의 기록으로.
 *
 * 왜 이 길이 있나
 * --------------
 * 티로의 '파일 전사'(Voice File Job) API 는 워크스페이스마다 티로가 켜 줘야
 * 쓸 수 있다. 안 켜진 계정에서 작업을 만들면 403 이다 —
 * "Voice File Job is not enabled for this workspace". 그동안은 폰에서 파일을
 * 올리는 길이 통째로 막힌다.
 *
 * 그런데 **티로 앱으로 녹음한 노트의 전사본은 읽기 API 로 그냥 가져올 수 있다.**
 * 올릴 것이 없으니 5시간 제한도, 파일 나누기도, 기다림도 없다. 티로가 이미
 * 다 받아적어 둔 것을 옮겨 오는 것이다.
 *
 * 가져온 뒤는 평소와 같다: 문장 나누기 → 병동 사전 교정 → 카드·보고서.
 * 다른 점은 오디오가 이 폰에 없다는 것뿐이다(재생은 티로 앱에서).
 */
import {
  DEFAULT_TEMPLATES,
  tiroParagraphsToSegments,
  type ShiftCode,
  type TiroParagraph,
} from "@nsr/core";
import {
  createRecording,
  finishImportedTranscript,
  getRecording,
  listRecordings,
  setRecordingState,
} from "../db";
import {
  TIRO_API,
  getTiroKey,
  saveAsrSegments,
  tiroError,
  tiroWorkspaceGuid,
} from "./asr";

export interface TiroNote {
  guid: string;
  title: string;
  /** 녹음이 시작된 시각(epoch ms). 모르면 만든 시각. */
  startedAt: number;
  durationSec: number;
}

async function tiroHeaders(): Promise<{ authorization: string }> {
  const key = await getTiroKey();
  if (!key) throw new Error("티로 열쇠가 없어요. 전사 설정에서 넣어 주세요.");
  return { authorization: `Bearer ${key}` };
}

/**
 * 티로 계정의 녹음 노트 목록. 최근 것부터.
 *
 * 워크스페이스별 목록이 정본이고, 옛 열쇠를 위해 전체 목록으로 한 번 더 시도한다.
 * 글자로만 쓴 노트(sourceType text)는 근무 기록이 아니라 뺀다.
 */
export async function listTiroNotes(limit = 50): Promise<TiroNote[]> {
  const headers = await tiroHeaders();
  const key = await getTiroKey();
  const guid = key ? await tiroWorkspaceGuid(key) : undefined;

  const urls = [
    guid ? `${TIRO_API}/v1/external/workspaces/${guid}/notes?size=${limit}` : "",
    `${TIRO_API}/v1/external/notes?size=${limit}`,
  ].filter(Boolean);

  let last: Response | null = null;
  for (const url of urls) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      last = res;
      continue;
    }
    const body = (await res.json()) as {
      content?: {
        guid?: string;
        title?: string;
        sourceType?: string;
        createdAt?: string;
        recordingStartAt?: string | null;
        recordingDurationSeconds?: number;
      }[];
    };
    return (body.content ?? [])
      .filter((n) => !!n.guid && n.sourceType !== "text" && n.sourceType !== "onboarding")
      .map((n) => ({
        guid: n.guid!,
        title: (n.title || "제목 없는 노트").trim(),
        startedAt: Date.parse(n.recordingStartAt || n.createdAt || "") || Date.now(),
        durationSec: n.recordingDurationSeconds ?? 0,
      }));
  }
  throw new Error(last ? await tiroError(last, "노트 목록 가져오기") : "노트를 가져오지 못했어요.");
}

/** 노트의 문단 전부. 커서로 나눠 오므로 끝까지 따라간다. */
async function fetchParagraphs(noteGuid: string): Promise<TiroParagraph[]> {
  const headers = await tiroHeaders();
  const out: TiroParagraph[] = [];
  let cursor = "";
  // 문단 200개씩, 최대 50쪽. 8시간 녹음도 이 안에 들어온다.
  for (let page = 0; page < 50; page++) {
    const url =
      `${TIRO_API}/v1/external/notes/${encodeURIComponent(noteGuid)}/paragraphs?size=200` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(await tiroError(res, "노트 내용 가져오기"));
    const body = (await res.json()) as { content?: TiroParagraph[]; nextCursor?: string | null };
    out.push(...(body.content ?? []));
    cursor = body.nextCursor ?? "";
    if (!cursor) break;
  }
  return out;
}

/** 근무 시작 시각(epoch ms) — 듀티 템플릿의 시작 시간. 시간이 없는 듀티는 09:00. */
function shiftStartMs(date: string, code: ShiftCode): number {
  const start = DEFAULT_TEMPLATES[code]?.startTime || "09:00";
  const [h, m] = start.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(y, mo - 1, d, h || 0, m || 0).getTime();
}

/**
 * 노트 하나를 근무의 기록으로 가져온다.
 *
 * 같은 노트를 두 번 가져오지 않는다 — 기록 id 가 노트 guid 로 정해져 있어서,
 * 이미 있으면 그 자리를 알려주고 멈춘다.
 */
export async function importTiroNote(input: {
  note: TiroNote;
  date: string;
  code: ShiftCode;
  /** 참이면 같은 근무의 다른 기록과 합치지 않고 따로 본다. */
  separate: boolean;
  onProgress?: (pct: number, note?: string) => void;
}): Promise<{ shiftId: string; recordingId: string; sentences: number; locked: number }> {
  const id = `tiro-${input.note.guid}`;
  const already = await getRecording(id);
  if (already) {
    throw new Error("이미 가져온 노트예요. 근무 기록에서 열어 보세요.");
  }

  input.onProgress?.(10, "티로에서 받아오는 중");
  const paragraphs = await fetchParagraphs(input.note.guid);
  if (paragraphs.length === 0) {
    throw new Error("이 노트에는 아직 전사본이 없어요. 티로에서 다 되었는지 봐 주세요.");
  }

  // 시각 기준점: 첫 문단이 시작한 시각. 없으면 노트의 녹음 시작 시각.
  const firstFrom = paragraphs.find((p) => p.timeFrom)?.timeFrom;
  const baseMs = (firstFrom ? Date.parse(firstFrom) : NaN) || input.note.startedAt;

  input.onProgress?.(40, "문장으로 나누는 중");
  const { segments, locked } = tiroParagraphsToSegments(paragraphs, baseMs);
  if (segments.length === 0) {
    throw new Error(
      locked > 0
        ? "이 노트는 티로에서 잠겨 있어요. 티로 요금제를 올리면 가져올 수 있어요."
        : "이 노트에서 가져올 말이 없어요. 다른 노트를 골라 보세요.",
    );
  }

  const shiftId = `${input.date}:${input.code}`;
  const existing = await listRecordings(shiftId);
  const seq = existing.reduce((max, r) => Math.max(max, r.seq), -1) + 1;
  // 시작 시각은 근무 시작 뒤 순번대로 — 목록이 가져온 차례대로 선다.
  const startedAt = shiftStartMs(input.date, input.code) + seq * 1000;
  const durationSec =
    input.note.durationSec || Math.round(segments.at(-1)?.endSec ?? 0);

  await createRecording({
    id,
    shiftId,
    seq,
    startedAt,
    label: input.note.title,
    separate: input.separate,
  });
  await finishImportedTranscript({
    id,
    endedAt: startedAt + durationSec * 1000,
    durationSec,
  });

  // 티로 전사본에 휘스퍼 오인식 목록을 들이대면 안 된다 — 다르게 틀린다.
  const sentences = await saveAsrSegments({
    recordingId: id,
    shiftId,
    segments,
    asrEngine: "other",
    onProgress: input.onProgress,
  });
  await setRecordingState(id, "transcribed");
  return { shiftId, recordingId: id, sentences, locked };
}
