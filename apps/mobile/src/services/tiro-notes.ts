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
  countSegments,
  createRecording,
  deleteRecordingRow,
  finishImportedTranscript,
  getRecording,
  listRecordings,
  setRecordingState,
  setSetting,
} from "../db";
import {
  TIRO_API,
  autoPushTiroWords,
  getTiroKey,
  refreshTaeumScore,
  saveImportedSegments,
  tiroError,
  tiroWorkspaceGuid,
} from "./asr";

/** 소리에서 만들어진 노트만 가져온다 (티로 OpenAPI 의 sourceType 목록). */
const SOUND_NOTES = ["live-voice", "recording", "offline-mode", "video"];

export interface TiroNote {
  guid: string;
  title: string;
  /** 녹음이 시작된 시각(epoch ms). 모르면 만든 시각. */
  startedAt: number;
  durationSec: number;
}

async function tiroHeaders(): Promise<{ authorization: string }> {
  const key = await getTiroKey();
  if (!key) throw new Error("티로 열쇠가 없어요. 설정에서 넣어 주세요.");
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

  // 겸사겸사 병동 사전에 새로 생긴 말을 티로 단어장에 올린다. 올려 두면 다음에
  // 티로 앱으로 녹음할 때 그 말을 알아듣는다. 실패해도 목록은 그대로 나온다.
  if (key) void autoPushTiroWords(key);

  // 워크스페이스 목록이 정본이다. `/v1/external/notes` 는 티로가 **폐기 예정**으로
  // 표시해 둔 옛 주소라, 열쇠가 옛것일 때의 대비로만 남겨 둔다 (OpenAPI: deprecated).
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
      // 소리가 있는 노트만. 나머지(글로 쓴 노트·웹페이지·안내용 견본)는 근무 기록이
      // 아니다. sourceType 값은 티로 OpenAPI 의 목록을 그대로 따른다.
      .filter((n) => !!n.guid && SOUND_NOTES.includes(n.sourceType ?? ""))
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
  // 한 쪽에 500개씩, 최대 40쪽. 티로 상한이 1000이라 500은 안전한 한 입이고,
  // 8시간 녹음(문단 수천 개)도 요청 몇 번이면 끝난다.
  for (let page = 0; page < 40; page++) {
    const url =
      `${TIRO_API}/v1/external/notes/${encodeURIComponent(noteGuid)}/paragraphs?size=500` +
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
    // 글자가 실제로 들어와 있을 때만 막는다.
    //
    // 예전에는 줄만 있으면 무조건 막았다. 그런데 줄은 가져오기 **시작할 때**
    // 만들어지고 문장은 몇 분 뒤에 들어온다. 그 사이에 앱이 죽거나 사용자가
    // '전사만 지우기' 를 누르면, 줄만 남아서 그 노트는 영영 다시 가져올 수
    // 없었다 — 화면 어디에도 그 사실이 안 적혀 있었다.
    const has = await countSegments(`${input.date}:${input.code}`);
    const mine = (await listRecordings(`${input.date}:${input.code}`)).find((r) => r.id === id);
    if (has > 0 && mine) {
      throw new Error("이미 가져온 노트예요. 근무 기록에서 열어 보세요.");
    }
    await deleteRecordingRow(id);
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
  try {
  await finishImportedTranscript({
    id,
    endedAt: startedAt + durationSec * 1000,
    durationSec,
  });

  const sentences = await saveImportedSegments({
    recordingId: id,
    shiftId,
    segments,
    onProgress: input.onProgress,
  });
  await setRecordingState(id, "transcribed");
  // 문장이 생긴 지금이 태움 점수를 다시 셀 자리다 (규칙 기반이라 값이 싸다).
  await refreshTaeumScore(shiftId);
  // 홈의 "새 전사 결과가 나왔어요" 줄이 이 값을 본다. 쓰는 곳이 없어서 그 줄은
  // 지금까지 한 번도 뜬 적이 없었다 (쓰던 코드가 전사 경로와 함께 지워졌다).
  await setSetting("transcribe.lastResult", { shiftId, sentences, seen: false });
  // 문장이 생겼으니 분석 서버로 저절로 보낸다. 가린 사본만 나가고, 서버가
  // 안 이어졌거나 설정에서 껐으면 아무 일도 안 한다 (nsr-server 의 autoSendPending).
  // 여기서 막혀도 가져오기 자체는 성공이라, 실패를 위로 던지지 않는다.
  void import("./nsr-server").then((m) => m.autoSendPending()).catch(() => {});
  return { shiftId, recordingId: id, sentences, locked };
  } catch (e) {
    // 반쯤 만들어진 줄을 남기지 않는다. 남기면 그 노트를 다시 못 가져온다.
    await deleteRecordingRow(id).catch(() => {});
    throw e;
  }
}
