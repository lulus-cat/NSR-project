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
  matchTiroUploads,
  tiroParagraphsToSegments,
  type ShiftCode,
  type TiroParagraph,
} from "@nsr/core";
import {
  createRecording,
  deleteRecordingRow,
  finishImportedTranscript,
  getRecording,
  getSetting,
  listRecordings,
  listSentRecordings,
  segmentCountsByRecording,
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
  /** 티로 OpenAPI 의 sourceType. 파일을 올려 만든 노트는 "recording". */
  source: string;
  /** 노트가 생긴 시각(epoch ms). 올린 파일은 티로가 다 받아적은 뒤에 생긴다. */
  createdAt: number;
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
        source: n.sourceType ?? "",
        createdAt: Date.parse(n.createdAt || "") || 0,
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
async function importOne(input: {
  note: TiroNote;
  date: string;
  code: ShiftCode;
  /** 참이면 같은 근무의 다른 기록과 합치지 않고 따로 본다. */
  separate: boolean;
  /** 이 노트가 된 녹음이 실제로 시작한 시각. 알면 순번 대신 이걸 쓴다. */
  startAt?: number;
  onProgress?: (pct: number, note?: string) => void;
}): Promise<{ shiftId: string; recordingId: string; sentences: number; locked: number }> {
  const id = `tiro-${input.note.guid}`;
  const already = await getRecording(id);
  if (already) {
    // 이 노트가 **다른 근무**에 이미 들어가 있으면 건드리지 않는다.
    // 예전에는 그냥 지웠는데, 줄을 지우면 그 근무의 문장까지 딸려 나간다 —
    // 사용자는 다른 날 전사본이 조용히 비는 것을 나중에야 안다.
    // shift_id 가 비어 있는 줄은 어느 근무에도 안 붙은 찌꺼기다. 그건 지워도 된다.
    if (already.shift_id && already.shift_id !== `${input.date}:${input.code}`) {
      throw new Error(
        `이 노트는 ${already.shift_id.split(":")[0]} 근무에 이미 있어요. 거기서 지우고 다시 해 주세요.`,
      );
    }

    // 글자가 실제로 들어와 있을 때만 막는다.
    //
    // 예전에는 줄만 있으면 무조건 막았다. 그런데 줄은 가져오기 **시작할 때**
    // 만들어지고 문장은 몇 분 뒤에 들어온다. 그 사이에 앱이 죽거나 사용자가
    // '전사만 지우기' 를 누르면, 줄만 남아서 그 노트는 영영 다시 가져올 수
    // 없었다 — 화면 어디에도 그 사실이 안 적혀 있었다.
    //
    // **이 기록 하나만 센다.** 근무 전체를 세면, 노트를 여럿 가져올 때 앞 노트가
    // 넣은 문장 때문에 뒤 노트가 "이미 가져왔다" 로 막힌다. 그리고 그 막힘은
    // 줄을 지우기 전에 일어나서, 그 노트는 영영 못 들어온다.
    const mineHas = already.shift_id
      ? ((await segmentCountsByRecording(already.shift_id)).get(id) ?? 0)
      : 0;
    if (mineHas > 0) {
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
  // 저절로 가져올 때는 그 녹음이 실제로 시작한 시각을 안다. 그걸 쓰면 세 시간짜리
  // 첫 조각이 짧은 끝 조각보다 늦게 받아적혀 와도 전사본이 시간 순서대로 이어진다.
  const startedAt = input.startAt ?? shiftStartMs(input.date, input.code) + seq * 1000;
  const durationSec =
    input.note.durationSec || Math.round(segments.at(-1)?.endSec ?? 0);

  await createRecording({
    id,
    shiftId,
    seq,
    startedAt,
    label: input.note.title,
    separate: input.separate,
    owner: "import",
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
  // 태움 다시 세기·홈 알림·서버로 보내기는 **여기서 안 한다.** 노트를 넷 고르면
  // 넷 다 돌아 값이 싸지 않고, 홈에는 마지막 한 편만 남아 "1개 들어왔다"로
  // 보인다. 묶음이 다 끝난 뒤 importTiroNotes 가 한 번만 한다.
  return { shiftId, recordingId: id, sentences, locked };
  } catch (e) {
    // 반쯤 만들어진 줄을 남기지 않는다. 남기면 그 노트를 다시 못 가져온다.
    await deleteRecordingRow(id).catch(() => {});
    throw e;
  }
}

export interface ImportFailure {
  title: string;
  reason: string;
}

export interface ImportManyResult {
  shiftId: string;
  /** 들어온 기록의 id — 따로 두면 화면이 이 중 첫 것을 열어야 한다. */
  recordingIds: string[];
  /** 실제로 들어온 노트 수. */
  imported: number;
  sentences: number;
  locked: number;
  /** 못 가져온 노트. 하나가 막혀도 나머지는 들어간다. */
  failed: ImportFailure[];
}

/**
 * 노트 여러 편을 근무 하나로 가져온다.
 *
 * **차례는 녹음이 시작된 시각순이다.** 고른 차례가 아니다 — 전사본은 시간 순서로
 * 읽혀야 하고, 사용자가 목록에서 아래 것을 먼저 눌렀다고 그 말이 앞에 오면 안 된다.
 *
 * **하나가 막혀도 멈추지 않는다.** 넷 중 셋째가 잠긴 노트라고 앞의 둘을 되돌리면
 * 이미 들어온 글을 지우는 셈이다. 못 가져온 것은 모아서 이름과 까닭을 돌려준다 —
 * 화면이 그걸 그대로 보여 준다.
 */
export async function importTiroNotes(input: {
  notes: TiroNote[];
  date: string;
  code: ShiftCode;
  /** 참이면 같은 근무의 다른 기록과 합치지 않고 따로 본다. */
  separate: boolean;
  /** 노트 guid → 그 노트가 된 녹음이 실제로 시작한 시각. 저절로 가져올 때만 안다. */
  startAt?: Record<string, number>;
  onProgress?: (pct: number, note?: string) => void;
}): Promise<ImportManyResult> {
  const shiftId = `${input.date}:${input.code}`;
  const at = (n: TiroNote) => input.startAt?.[n.guid] ?? n.startedAt;
  const notes = [...input.notes].sort((a, b) => at(a) - at(b));
  if (notes.length === 0) throw new Error("가져올 노트를 골라 주세요.");

  const recordingIds: string[] = [];
  let imported = 0;
  let sentences = 0;
  let locked = 0;
  const failed: ImportFailure[] = [];

  for (const [i, note] of notes.entries()) {
    const head = notes.length > 1 ? `${i + 1}/${notes.length} ` : "";
    try {
      const out = await importOne({
        note,
        date: input.date,
        code: input.code,
        separate: input.separate,
        startAt: input.startAt?.[note.guid],
        // 한 편의 0~100 을 묶음 전체의 제 몫으로 옮긴다.
        onProgress: (pct, msg) =>
          input.onProgress?.(
            Math.round(((i + pct / 100) / notes.length) * 100),
            msg ? `${head}${msg}` : undefined,
          ),
      });
      imported += 1;
      recordingIds.push(out.recordingId);
      sentences += out.sentences;
      locked += out.locked;
    } catch (e) {
      failed.push({
        title: note.title,
        reason: e instanceof Error ? e.message : "가져오지 못했어요.",
      });
    }
  }

  // 한 편도 못 들어왔으면 화면이 성공으로 넘어가면 안 된다.
  if (imported === 0) {
    throw new Error(failed[0]?.reason ?? "가져오지 못했어요. 다시 눌러 주세요.");
  }

  // 여기서 한 번만 한다 — 편마다 하면 태움을 여러 번 다시 세고, 홈에는 마지막
  // 한 편의 문장 수만 남는다.
  await refreshTaeumScore(shiftId);
  await setSetting("transcribe.lastResult", { shiftId, sentences, seen: false });
  // 가린 사본만 나간다. 서버가 안 이어졌거나 설정에서 껐으면 아무 일도 안 한다.
  // 여기서 막혀도 가져오기 자체는 성공이라 실패를 위로 던지지 않는다.
  void import("./nsr-server").then((m) => m.autoSendPending()).catch(() => {});

  return { shiftId, recordingIds, imported, sentences, locked, failed };
}

/** 저절로 가져오다 막힌 까닭 — 근무 기록 화면이 보여 준다. 근무마다 하나. */
export const tiroAutoErrorKey = (shiftId: string) => `tiro.auto.error.${shiftId}`;
/** 이 녹음의 글자는 이미 데려왔다 — 다시 짝짓지 않는다. */
const matchedKey = (recordingId: string) => `tiro.auto.matched.${recordingId}`;
/** 이보다 오래 기다린 녹음은 사람이 손으로 가져갔다고 보고 티로에 그만 묻는다. */
const AUTO_WINDOW_MS = 14 * 86_400_000;

/**
 * 티로로 보낸 녹음의 글자를 저절로 데려온다 — 홈과 근무 기록 화면이 열릴 때.
 *
 * 녹음을 티로로 보낸 뒤에는 사람이 '티로 노트에서 글자 가져오기' 에서 날짜·듀티·
 * 노트를 손으로 골라야 서버 → 클로드 분석으로 이어졌다. 그 단계가 화면 어디에도
 * 안 보여서, 티로에 글자가 다 있는데 근무 기록은 '먼저 티로에서 전사본을
 * 가져오세요' 에 멈춰 있었다(10월 12일).
 *
 * 짝짓기 규칙은 core 의 matchTiroUploads 에 있다 — 틀리게 붙이느니 안 붙인다.
 * 짝이 안 지어지는 노트는 지금처럼 손으로 가져온다. 들어오면 importTiroNotes 가
 * 평소처럼 서버로 보낸다. 거기서부터는 손으로 가져온 것과 같은 길이다.
 *
 * @returns 글자가 들어온 근무 수.
 */
let autoRun: Promise<number> | null = null;

export function autoImportFromTiro(): Promise<number> {
  // 홈과 근무 기록 화면이 함께 부르면 같은 노트를 두 번 가져오려 든다. 하나만 돈다.
  return (autoRun ??= autoImportOnce().finally(() => {
    autoRun = null;
  }));
}

async function autoImportOnce(): Promise<number> {
  if (!(await getTiroKey())) return 0;
  const rows = await listSentRecordings(Date.now() - AUTO_WINDOW_MS);
  const waiting = [];
  for (const r of rows) {
    if (await getSetting<string | null>(matchedKey(r.id), null)) continue;
    waiting.push({
      id: r.id,
      shiftId: r.shift_id!,
      endedAt: r.ended_at ?? r.started_at + r.duration_sec * 1000,
      durationSec: r.duration_sec,
      fileStem: r.file_uri?.split("/").pop()?.replace(/\.[^.]+$/, ""),
    });
  }
  // 기다리는 녹음이 없으면 티로에 묻지도 않는다.
  if (waiting.length === 0) return 0;

  const shifts = [...new Set(waiting.map((w) => w.shiftId))];
  let notes: TiroNote[];
  try {
    notes = await listTiroNotes();
  } catch (e) {
    // 열쇠가 틀렸거나 그물이 끊겼다. 조용히 넘기면 화면은 '저절로 가져와요' 만 말한다.
    // fetch 는 그물이 끊기면 영어로 던진다 — 그대로 내보내지 않는다.
    const said = e instanceof Error && /[가-힣]/.test(e.message) ? e.message : "";
    for (const id of shifts) {
      await setSetting(tiroAutoErrorKey(id), said || "티로에 닿지 못했어요. 인터넷을 확인해 주세요.");
    }
    return 0;
  }
  for (const id of shifts) await setSetting(tiroAutoErrorKey(id), null);

  const fresh: TiroNote[] = [];
  for (const n of notes) {
    // 이미 가져온 노트는 뺀다. 줄만 있고 글자가 없으면 가져오다 앱이 죽은 것이다 —
    // 그건 다시 가져온다(importOne 이 그 줄을 치우고 새로 넣는다).
    const row = await getRecording(`tiro-${n.guid}`);
    const has = row?.shift_id ? ((await segmentCountsByRecording(row.shift_id)).get(row.id) ?? 0) : 0;
    if (!row || has === 0) fresh.push(n);
  }
  const pairs = matchTiroUploads(fresh, waiting);
  const startOf = new Map(rows.map((r) => [r.id, r.started_at]));

  // 올린 파일의 노트가 있는데 짝을 못 지었으면 기다려도 안 온다. 그때는 손으로 고르게
  // 말한다 — 안 그러면 화면은 '저절로 가져와요' 만 영원히 말한다.
  const firstEnd = Math.min(...waiting.map((w) => w.endedAt));
  const stranded = fresh.some(
    (n) => n.source === "recording" && n.createdAt >= firstEnd && !pairs.some((p) => p.noteGuid === n.guid),
  );
  if (stranded) {
    for (const id of shifts) {
      if (!pairs.some((p) => p.shiftId === id)) {
        await setSetting(tiroAutoErrorKey(id), "티로 노트와 짝을 못 지었어요. 홈에서 골라 주세요.");
      }
    }
  }

  const byShift = new Map<string, typeof pairs>();
  for (const p of pairs) byShift.set(p.shiftId, [...(byShift.get(p.shiftId) ?? []), p]);

  let done = 0;
  for (const [shiftId, group] of byShift) {
    const [date, code] = shiftId.split(":");
    try {
      const out = await importTiroNotes({
        notes: group.map((p) => fresh.find((n) => n.guid === p.noteGuid)!),
        date,
        code: code as ShiftCode,
        separate: false,
        startAt: Object.fromEntries(group.map((p) => [p.noteGuid, startOf.get(p.recordingId)!])),
      });
      // 들어온 노트의 녹음만 짝지은 것으로 적는다 — 막힌 노트는 다음에 다시 본다.
      const got = new Set(out.recordingIds.map((id) => id.replace(/^tiro-/, "")));
      for (const p of group) if (got.has(p.noteGuid)) await setSetting(matchedKey(p.recordingId), p.noteGuid);
      await setSetting(tiroAutoErrorKey(shiftId), out.failed[0]?.reason ?? null);
      done += 1;
    } catch (e) {
      // 화면이 말해야 한다 — 안 그러면 '저절로 가져와요' 만 영원히 보인다.
      await setSetting(
        tiroAutoErrorKey(shiftId),
        e instanceof Error ? e.message : "티로에서 가져오지 못했어요. 다시 열어 주세요.",
      );
    }
  }
  return done;
}
