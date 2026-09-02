/**
 * SQLite 접근 계층.
 *
 * 화면 코드가 SQL을 직접 쓰지 않도록 여기서 도메인 타입으로 감싼다.
 * @nsr/core의 순수 함수들은 DB를 모르고, 이 파일이 둘 사이를 잇는다.
 */

import * as SQLite from "expo-sqlite";
import type {
  Card,
  DutyEntry,
  LexiconEntry,
  ReviewState,
  ShiftCode,
  SpeakerRole,
  TaeumScore,
  TermAnnotation,
  TranscriptSegment,
  CorrectionMemory,
  WardPack,
  PackCorrection,
  Edit,
} from "@nsr/core";
import { SCHEMA_SQL } from "./schema";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("nsr.db");
      await db.execAsync(SCHEMA_SQL);
      // 기존 설치에 새 열을 붙인다. CREATE TABLE IF NOT EXISTS 는 있는 표를
      // 안 건드리므로 열이 없으면 ALTER 로 더한다 — 두 번 돌아도 안전하다.
      const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(recordings)");
      const have = new Set(cols.map((c) => c.name));
      if (!have.has("label")) {
        await db.execAsync("ALTER TABLE recordings ADD COLUMN label TEXT");
      }
      if (!have.has("separate")) {
        await db.execAsync(
          "ALTER TABLE recordings ADD COLUMN separate INTEGER NOT NULL DEFAULT 0",
        );
      }
      // 전사 도중 앱이 죽으면(프로세스 종료·강제 종료) 'transcribing' 이 영영
      // 남는다. 그러면 그 기록은 '전사할 기록'에서 사라져 다시 전사할 길이
      // 없다 — 실사용에서 콜랩 끊김 뒤 그대로 재현된 사고다. 러너는 프로세스
      // 안에서만 돌므로, 새로 열 때 남아 있는 'transcribing' 은 전부 유령이다.
      await db.runAsync("UPDATE recordings SET state = 'recorded' WHERE state = 'transcribing'");
      return db;
    })();
  }
  return dbPromise;
}

/** 테스트/로그아웃용. 다음 호출에서 다시 연다. */
export function resetDbHandle(): void {
  dbPromise = null;
}

// ── 설정 ────────────────────────────────────────────────

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

// ── 듀티표 ──────────────────────────────────────────────

interface DutyRow {
  date: string;
  code: string;
  override_start: string | null;
  override_end: string | null;
  note: string | null;
}

function toDutyEntry(row: DutyRow): DutyEntry {
  const entry: DutyEntry = { date: row.date, code: row.code as ShiftCode };
  if (row.override_start) entry.overrideStart = row.override_start;
  if (row.override_end) entry.overrideEnd = row.override_end;
  if (row.note) entry.note = row.note;
  return entry;
}

export async function listDutyEntries(
  fromDate?: string,
  toDate?: string,
): Promise<DutyEntry[]> {
  const db = await getDb();
  const rows =
    fromDate && toDate
      ? await db.getAllAsync<DutyRow>(
          "SELECT * FROM duty_entries WHERE date BETWEEN ? AND ? ORDER BY date",
          [fromDate, toDate],
        )
      : await db.getAllAsync<DutyRow>("SELECT * FROM duty_entries ORDER BY date");
  return rows.map(toDutyEntry);
}

export async function upsertDutyEntries(entries: DutyEntry[]): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const e of entries) {
      await db.runAsync(
        `INSERT INTO duty_entries (date, code, override_start, override_end, note)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           code = excluded.code,
           override_start = excluded.override_start,
           override_end = excluded.override_end,
           note = excluded.note`,
        [e.date, e.code, e.overrideStart ?? null, e.overrideEnd ?? null, e.note ?? null],
      );
    }
  });
}

export async function deleteDutyEntry(date: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM duty_entries WHERE date = ?", [date]);
}

// ── 녹음 ────────────────────────────────────────────────

export type RecordingState =
  | "recording"
  | "recorded"
  | "transcribing"
  | "transcribed"
  | "discarded";

export interface RecordingRow {
  id: string;
  shift_id: string | null;
  seq: number;
  started_at: number;
  ended_at: number | null;
  duration_sec: number;
  file_uri: string | null;
  size_bytes: number;
  state: RecordingState;
  discard_reason: string | null;
  /** 가져온 파일의 원래 이름. 녹음기가 만든 파일은 null. */
  label: string | null;
  /** 1 이면 같은 근무의 다른 기록과 합치지 않고 따로 본다. */
  separate: number;
  created_at: number;
}

export async function createRecording(input: {
  id: string;
  shiftId: string | null;
  seq: number;
  startedAt: number;
  /** 가져온 파일의 원래 이름. */
  label?: string;
  /** 참이면 같은 근무의 다른 기록과 합치지 않는다. */
  separate?: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO recordings (id, shift_id, seq, started_at, label, separate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.shiftId,
      input.seq,
      input.startedAt,
      input.label ?? null,
      input.separate ? 1 : 0,
      Date.now(),
    ],
  );
}

export async function finishRecording(input: {
  id: string;
  endedAt: number;
  durationSec: number;
  fileUri: string;
  sizeBytes: number;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE recordings
        SET ended_at = ?, duration_sec = ?, file_uri = ?, size_bytes = ?, state = 'recorded'
      WHERE id = ?`,
    [input.endedAt, input.durationSec, input.fileUri, input.sizeBytes, input.id],
  );
}

export async function setRecordingState(
  id: string,
  state: RecordingState,
  discardReason?: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE recordings SET state = ?, discard_reason = ? WHERE id = ?",
    [state, discardReason ?? null, id],
  );
}

export async function listRecordings(shiftId?: string): Promise<RecordingRow[]> {
  const db = await getDb();
  return shiftId
    ? db.getAllAsync<RecordingRow>(
        "SELECT * FROM recordings WHERE shift_id = ? ORDER BY seq",
        [shiftId],
      )
    : db.getAllAsync<RecordingRow>(
        "SELECT * FROM recordings ORDER BY started_at DESC LIMIT 200",
      );
}

export async function pendingTranscriptions(): Promise<RecordingRow[]> {
  const db = await getDb();
  return db.getAllAsync<RecordingRow>(
    "SELECT * FROM recordings WHERE state = 'recorded' ORDER BY started_at",
  );
}

/** 학습 탭의 파일별 전사 목록 — 전사가 끝난 기록과 그 문장 수. */
export interface TranscribedRecordingRow {
  id: string;
  shift_id: string | null;
  started_at: number;
  duration_sec: number;
  label: string | null;
  separate: number;
  sentences: number;
}

export async function listTranscribedRecordings(
  limit = 100,
): Promise<TranscribedRecordingRow[]> {
  const db = await getDb();
  return db.getAllAsync<TranscribedRecordingRow>(
    `SELECT r.id, r.shift_id, r.started_at, r.duration_sec, r.label, r.separate,
            (SELECT COUNT(*) FROM segments s WHERE s.recording_id = r.id) AS sentences
       FROM recordings r
      WHERE r.state = 'transcribed'
      ORDER BY r.started_at DESC
      LIMIT ?`,
    [limit],
  );
}

/** 보관기간이 지난 녹음의 파일 경로를 돌려주고 행을 지운다. 파일 삭제는 호출부가 한다. */
export async function expireRecordings(olderThan: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; file_uri: string | null }>(
    "SELECT id, file_uri FROM recordings WHERE started_at < ?",
    [olderThan],
  );
  await db.runAsync("DELETE FROM recordings WHERE started_at < ?", [olderThan]);
  return rows.map((r) => r.file_uri).filter((u): u is string => !!u);
}

/**
 * 전사만 지운다 — 문장(과 딸린 편집·주석)이 지워지고, 녹음은 '녹음됨'으로
 * 돌아가 다시 전사할 수 있다. 음성 파일은 건드리지 않는다.
 */
export async function deleteTranscript(
  shiftId: string,
  /** 주면 이 기록들의 전사본만 — 따로 둔 파일은 제 화면에서 제 것만 지운다. */
  recordingIds?: string[],
): Promise<void> {
  const db = await getDb();
  if (recordingIds) {
    for (const id of recordingIds) {
      await db.runAsync("DELETE FROM segments WHERE shift_id = ? AND recording_id = ?", [
        shiftId,
        id,
      ]);
      await db.runAsync(
        "UPDATE recordings SET state = 'recorded' WHERE id = ? AND state = 'transcribed'",
        [id],
      );
    }
    return;
  }
  await db.runAsync("DELETE FROM segments WHERE shift_id = ?", [shiftId]);
  await db.runAsync(
    "UPDATE recordings SET state = 'recorded' WHERE shift_id = ? AND state = 'transcribed'",
    [shiftId],
  );
}

/** 전사와 녹음을 함께 지운다. 지울 파일 경로를 돌려준다 — 파일 삭제는 호출부가 한다. */
export async function deleteShiftRecordings(
  shiftId: string,
  recordingIds?: string[],
): Promise<string[]> {
  const db = await getDb();
  if (recordingIds) {
    const out: string[] = [];
    for (const id of recordingIds) {
      const row = await db.getFirstAsync<{ file_uri: string | null }>(
        "SELECT file_uri FROM recordings WHERE id = ?",
        [id],
      );
      await db.runAsync("DELETE FROM segments WHERE recording_id = ?", [id]);
      await db.runAsync("DELETE FROM recordings WHERE id = ?", [id]);
      if (row?.file_uri) out.push(row.file_uri);
    }
    return out;
  }
  const rows = await db.getAllAsync<{ file_uri: string | null }>(
    "SELECT file_uri FROM recordings WHERE shift_id = ?",
    [shiftId],
  );
  await db.runAsync("DELETE FROM segments WHERE shift_id = ?", [shiftId]);
  await db.runAsync("DELETE FROM recordings WHERE shift_id = ?", [shiftId]);
  return rows.map((r) => r.file_uri).filter((u): u is string => !!u);
}

export async function totalStorageBytes(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null }>(
    "SELECT SUM(size_bytes) AS total FROM recordings",
  );
  return row?.total ?? 0;
}

// ── 전사 ────────────────────────────────────────────────

interface SegmentRow {
  id: string;
  recording_id: string;
  shift_id: string | null;
  start_sec: number;
  end_sec: number;
  raw_text: string;
  text: string;
  speaker_id: string | null;
  speaker_role: string | null;
  asr_confidence: number | null;
}

function toSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    startSec: row.start_sec,
    endSec: row.end_sec,
    rawText: row.raw_text,
    text: row.text,
    speakerId: row.speaker_id ?? undefined,
    speakerRole: (row.speaker_role as SpeakerRole) ?? undefined,
    asrConfidence: row.asr_confidence ?? undefined,
  };
}

export async function saveSegments(
  recordingId: string,
  shiftId: string | null,
  segments: TranscriptSegment[],
  perSegment: { edits: Edit[]; annotations: TermAnnotation[] }[],
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      await db.runAsync(
        `INSERT INTO segments
           (id, recording_id, shift_id, start_sec, end_sec, raw_text, text, speaker_id, speaker_role, asr_confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           speaker_role = excluded.speaker_role`,
        [
          s.id,
          recordingId,
          shiftId,
          s.startSec,
          s.endSec,
          s.rawText,
          s.text,
          s.speakerId ?? null,
          s.speakerRole ?? null,
          s.asrConfidence ?? null,
        ],
      );

      const extra = perSegment[i];
      if (!extra) continue;
      for (const [j, e] of extra.edits.entries()) {
        await db.runAsync(
          `INSERT OR REPLACE INTO edits
             (id, segment_id, start_pos, end_pos, from_text, to_text, reason, entry_id, confidence, accepted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            `${s.id}#e${j}`,
            s.id,
            e.start,
            e.end,
            e.from,
            e.to,
            e.reason,
            e.entryId ?? null,
            e.confidence,
          ],
        );
      }
      for (const [j, a] of extra.annotations.entries()) {
        await db.runAsync(
          `INSERT OR REPLACE INTO annotations
             (id, segment_id, start_pos, end_pos, surface, entry_id, via, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [`${s.id}#a${j}`, s.id, a.start, a.end, a.surface, a.entryId, a.via, a.confidence],
        );
      }
    }
  });
}

/** 근무 화면의 요약용 — 수천 문장을 다 읽지 않고 개수만 센다. */
export async function countSegments(shiftId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM segments WHERE shift_id = ?",
    [shiftId],
  );
  return row?.n ?? 0;
}

/** 기록별 문장 수 — 근무 화면이 파일마다 몇 문장인지 보일 때. */
export async function segmentCountsByRecording(shiftId: string): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ recording_id: string; n: number }>(
    "SELECT recording_id, COUNT(*) AS n FROM segments WHERE shift_id = ? GROUP BY recording_id",
    [shiftId],
  );
  return new Map(rows.map((r) => [r.recording_id, r.n]));
}

/**
 * 근무의 전사 문장.
 *
 * 시각(start_sec)은 파일 안 기준이라, 한 근무에 파일이 여럿이면 파일 차례(seq)로
 * 먼저 줄 세워야 한다 — start_sec 만으로 정렬하면 30분마다 잘린 두 파일이 뒤섞인다.
 *
 *  · recordingId: 그 기록 하나만 ('따로' 둔 파일의 결과 화면).
 *  · mergedOnly:  '따로' 둔 기록을 뺀 나머지 (합친 전사본 화면).
 *  · 둘 다 없으면 전부 — 카드·지표·내보내기는 근무 전체를 본다.
 */
export async function listSegments(
  shiftId: string,
  opts: { recordingId?: string; mergedOnly?: boolean } = {},
): Promise<TranscriptSegment[]> {
  const db = await getDb();
  const rows = opts.recordingId
    ? await db.getAllAsync<SegmentRow>(
        "SELECT * FROM segments WHERE shift_id = ? AND recording_id = ? ORDER BY start_sec",
        [shiftId, opts.recordingId],
      )
    : await db.getAllAsync<SegmentRow>(
        `SELECT s.* FROM segments s
           LEFT JOIN recordings r ON r.id = s.recording_id
          WHERE s.shift_id = ?${opts.mergedOnly ? " AND COALESCE(r.separate, 0) = 0" : ""}
          ORDER BY COALESCE(r.seq, 0), COALESCE(r.started_at, 0), s.start_sec`,
        [shiftId],
      );
  return rows.map(toSegment);
}

export async function listAnnotations(shiftId: string): Promise<
  (TermAnnotation & { segmentId: string })[]
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    segment_id: string;
    start_pos: number;
    end_pos: number;
    surface: string;
    entry_id: string;
    via: string;
    confidence: number;
  }>(
    `SELECT a.* FROM annotations a
       JOIN segments s ON s.id = a.segment_id
      WHERE s.shift_id = ?
      ORDER BY s.start_sec, a.start_pos`,
    [shiftId],
  );
  return rows.map((r) => ({
    segmentId: r.segment_id,
    start: r.start_pos,
    end: r.end_pos,
    surface: r.surface,
    entryId: r.entry_id,
    via: r.via as TermAnnotation["via"],
    confidence: r.confidence,
  }));
}

export async function setSpeakerRole(
  segmentId: string,
  role: SpeakerRole,
): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE segments SET speaker_role = ? WHERE id = ?", [role, segmentId]);
}

/** 같은 화자 클러스터 전체에 역할을 한 번에 지정한다. 하나씩 찍게 하면 아무도 안 쓴다. */
export async function setSpeakerRoleForCluster(
  shiftId: string,
  speakerId: string,
  role: SpeakerRole,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE segments SET speaker_role = ? WHERE shift_id = ? AND speaker_id = ?",
    [role, shiftId, speakerId],
  );
}

/** 사용자가 본문을 직접 고쳤을 때. 원문(raw_text)은 건드리지 않는다. */
export async function updateSegmentText(
  segmentId: string,
  text: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE segments SET text = ? WHERE id = ?", [text, segmentId]);
}

// ── 교정 학습 ───────────────────────────────────────────

export async function loadCorrectionMemory(minCount = 2): Promise<CorrectionMemory> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    key: string;
    from_text: string;
    to_text: string;
    count: number;
    last_used_at: number;
  }>("SELECT * FROM correction_rules");
  const rules: CorrectionMemory["rules"] = {};
  for (const r of rows) {
    rules[r.key] = {
      from: r.from_text,
      to: r.to_text,
      count: r.count,
      lastUsedAt: r.last_used_at,
    };
  }
  return { rules, minCount };
}

export async function saveCorrectionMemory(memory: CorrectionMemory): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM correction_rules");
    for (const [key, rule] of Object.entries(memory.rules)) {
      await db.runAsync(
        "INSERT INTO correction_rules (key, from_text, to_text, count, last_used_at) VALUES (?, ?, ?, ?, ?)",
        [key, rule.from, rule.to, rule.count, rule.lastUsedAt],
      );
    }
  });
}

// ── 사용자 사전 ─────────────────────────────────────────

export async function listUserTerms(): Promise<LexiconEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ payload: string }>(
    "SELECT payload FROM user_terms",
  );
  const out: LexiconEntry[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload) as LexiconEntry);
    } catch {
      // 손상된 항목은 건너뛴다. 사전 하나 때문에 앱이 못 뜨면 안 된다.
    }
  }
  return out;
}

export async function saveUserTerm(entry: LexiconEntry): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO user_terms (id, payload) VALUES (?, ?)",
    [entry.id, JSON.stringify(entry)],
  );
}

export async function deleteUserTerm(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM user_terms WHERE id = ?", [id]);
}

// ── 학습카드 ────────────────────────────────────────────

interface CardRow {
  id: string;
  kind: string;
  front: string;
  back: string;
  entry_id: string;
  shift_id: string | null;
  segment_id: string | null;
  context: string | null;
  source_ids: string;
  created_at: number;
  suspended: number;
}

function toCard(row: CardRow): Card {
  let sourceIds: string[] = [];
  try {
    sourceIds = JSON.parse(row.source_ids) as string[];
  } catch {
    sourceIds = [];
  }
  return {
    id: row.id,
    kind: row.kind as Card["kind"],
    front: row.front,
    back: row.back,
    entryId: row.entry_id,
    shiftId: row.shift_id ?? undefined,
    segmentId: row.segment_id ?? undefined,
    context: row.context ?? undefined,
    sourceIds,
    createdAt: row.created_at,
  };
}

export async function saveCards(cards: Card[], now: number): Promise<number> {
  const db = await getDb();
  let inserted = 0;
  await db.withTransactionAsync(async () => {
    for (const c of cards) {
      const result = await db.runAsync(
        `INSERT INTO cards (id, kind, front, back, entry_id, shift_id, segment_id, context, source_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [
          c.id,
          c.kind,
          c.front,
          c.back,
          c.entryId,
          c.shiftId ?? null,
          c.segmentId ?? null,
          c.context ?? null,
          JSON.stringify(c.sourceIds),
          c.createdAt,
        ],
      );
      if (result.changes > 0) {
        inserted += 1;
        await db.runAsync(
          "INSERT OR IGNORE INTO review_states (card_id, due_at) VALUES (?, ?)",
          [c.id, now],
        );
      }
    }
  });
  return inserted;
}

export async function listCards(limit = 500): Promise<Card[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CardRow>(
    "SELECT * FROM cards WHERE suspended = 0 ORDER BY created_at DESC LIMIT ?",
    [limit],
  );
  return rows.map(toCard);
}

/** 한 근무에서 나온 카드만. 내보내기가 근무 단위라 따로 둔다. */
export async function listCardsForShift(shiftId: string): Promise<Card[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CardRow>(
    "SELECT * FROM cards WHERE shift_id = ? ORDER BY created_at ASC",
    [shiftId],
  );
  return rows.map(toCard);
}

export async function knownEntryIds(matureIntervalDays = 21): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ entry_id: string }>(
    `SELECT DISTINCT c.entry_id
       FROM cards c JOIN review_states r ON r.card_id = c.id
      WHERE r.interval_days >= ?`,
    [matureIntervalDays],
  );
  return new Set(rows.map((r) => r.entry_id));
}

interface ReviewRow {
  card_id: string;
  repetitions: number;
  interval_days: number;
  ease_factor: number;
  due_at: number;
  lapses: number;
  last_reviewed_at: number | null;
}

function toReviewState(row: ReviewRow): ReviewState {
  return {
    cardId: row.card_id,
    repetitions: row.repetitions,
    intervalDays: row.interval_days,
    easeFactor: row.ease_factor,
    dueAt: row.due_at,
    lapses: row.lapses,
    lastReviewedAt: row.last_reviewed_at ?? undefined,
  };
}

export async function listReviewStates(): Promise<ReviewState[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ReviewRow>("SELECT * FROM review_states");
  return rows.map(toReviewState);
}

export async function saveReviewState(state: ReviewState): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO review_states
       (card_id, repetitions, interval_days, ease_factor, due_at, lapses, last_reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id) DO UPDATE SET
       repetitions = excluded.repetitions,
       interval_days = excluded.interval_days,
       ease_factor = excluded.ease_factor,
       due_at = excluded.due_at,
       lapses = excluded.lapses,
       last_reviewed_at = excluded.last_reviewed_at`,
    [
      state.cardId,
      state.repetitions,
      state.intervalDays,
      state.easeFactor,
      state.dueAt,
      state.lapses,
      state.lastReviewedAt ?? null,
    ],
  );
}

// ── 태움 지표 · 보고서 ──────────────────────────────────

export async function saveTaeumScore(shiftId: string, score: TaeumScore): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO taeum_scores (shift_id, score, level, payload, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(shift_id) DO UPDATE SET
       score = excluded.score, level = excluded.level,
       payload = excluded.payload, created_at = excluded.created_at`,
    [shiftId, score.score, score.level, JSON.stringify(score), Date.now()],
  );
}

export async function getTaeumScore(shiftId: string): Promise<TaeumScore | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ payload: string }>(
    "SELECT payload FROM taeum_scores WHERE shift_id = ?",
    [shiftId],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as TaeumScore;
  } catch {
    return null;
  }
}

export async function listTaeumScores(limit = 60): Promise<
  { shiftId: string; score: number; level: string; createdAt: number }[]
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    shift_id: string;
    score: number;
    level: string;
    created_at: number;
  }>(
    "SELECT shift_id, score, level, created_at FROM taeum_scores ORDER BY shift_id DESC LIMIT ?",
    [limit],
  );
  return rows.map((r) => ({
    shiftId: r.shift_id,
    score: r.score,
    level: r.level,
    createdAt: r.created_at,
  }));
}

export async function saveShiftReport(
  shiftId: string,
  markdown: string,
  payload: unknown,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO shift_reports (shift_id, markdown, payload, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(shift_id) DO UPDATE SET
       markdown = excluded.markdown, payload = excluded.payload, created_at = excluded.created_at`,
    [shiftId, markdown, JSON.stringify(payload), Date.now()],
  );
}

export interface ShiftReportRow {
  shiftId: string;
  createdAt: number;
  /** 저장해 둔 ShiftReport. 화면에서 개수 요약을 만드는 데 쓴다. */
  payload: unknown;
}

/* ── 노트 ─────────────────────────────────────────────────────── */

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

function toNote(r: {
  id: string;
  title: string;
  body: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}): NoteRow {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listNotes(query?: string): Promise<NoteRow[]> {
  const db = await getDb();
  const q = (query ?? "").trim();
  const rows = q
    ? await db.getAllAsync<Parameters<typeof toNote>[0]>(
        "SELECT * FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY pinned DESC, updated_at DESC",
        [`%${q}%`, `%${q}%`],
      )
    : await db.getAllAsync<Parameters<typeof toNote>[0]>(
        "SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC",
      );
  return rows.map(toNote);
}

export async function getNote(id: string): Promise<NoteRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Parameters<typeof toNote>[0]>(
    "SELECT * FROM notes WHERE id = ?",
    [id],
  );
  return r ? toNote(r) : null;
}

export async function getNoteByTitle(title: string): Promise<NoteRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Parameters<typeof toNote>[0]>(
    "SELECT * FROM notes WHERE title = ? COLLATE NOCASE",
    [title.trim()],
  );
  return r ? toNote(r) : null;
}

export async function saveNote(input: {
  id?: string;
  title: string;
  body: string;
  pinned?: boolean;
}): Promise<string> {
  const db = await getDb();
  const now = Date.now();
  const id = input.id ?? `note_${now}_${Math.random().toString(36).slice(2, 8)}`;
  await db.runAsync(
    `INSERT INTO notes (id, title, body, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, body = excluded.body,
       pinned = excluded.pinned, updated_at = excluded.updated_at`,
    [id, input.title.trim() || "제목 잃어버림", input.body, input.pinned ? 1 : 0, now, now],
  );
  return id;
}

export async function deleteNote(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM notes WHERE id = ?", [id]);
}

/** 이 제목을 [[위키링크]]로 참조하는 노트들 — 백링크. */
export async function notesLinkingTo(title: string, excludeId?: string): Promise<NoteRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Parameters<typeof toNote>[0]>(
    "SELECT * FROM notes WHERE body LIKE ? AND id != ? ORDER BY updated_at DESC",
    [`%[[${title.trim()}%`, excludeId ?? ""],
  );
  // LIKE 는 "[[제목..." 접두까지만 거른다. 별칭([[제목|별칭]])과 정확 일치를 여기서 판정한다.
  const re = new RegExp(`\\[\\[${title.trim().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(\\|[^\\]]*)?\\]\\]`);
  return rows.map(toNote).filter((n) => re.test(n.body));
}

/** 한 근무의 보고서 전체 — 마크다운과 분석 원본(payload)을 함께 준다. */
export async function getShiftReport(
  shiftId: string,
): Promise<{ markdown: string; payload: unknown; createdAt: number } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ markdown: string; payload: string; created_at: number }>(
    "SELECT markdown, payload, created_at FROM shift_reports WHERE shift_id = ?",
    [shiftId],
  );
  if (!row) return null;
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = null; // 저장이 깨졌어도 마크다운은 내보낼 수 있어야 한다.
  }
  return { markdown: row.markdown, payload, createdAt: row.created_at };
}

export async function listShiftReports(limit = 60): Promise<ShiftReportRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ shift_id: string; created_at: number; payload: string }>(
    "SELECT shift_id, created_at, payload FROM shift_reports ORDER BY shift_id DESC LIMIT ?",
    [limit],
  );
  return rows.map((r) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = null;
    }
    return { shiftId: r.shift_id, createdAt: r.created_at, payload };
  });
}

export async function getShiftReportMarkdown(shiftId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ markdown: string }>(
    "SELECT markdown FROM shift_reports WHERE shift_id = ?",
    [shiftId],
  );
  return row?.markdown ?? null;
}


// ── 병동 사전 ───────────────────────────────────────────

export interface StoredPack {
  pack: WardPack;
  enabled: boolean;
  priority: number;
  importedAt: number;
}

interface PackRow {
  id: string;
  name: string;
  hospital: string | null;
  ward: string | null;
  payload: string;
  enabled: number;
  priority: number;
  updated_at: number;
  imported_at: number;
}

function toStoredPack(row: PackRow): StoredPack | null {
  try {
    return {
      pack: JSON.parse(row.payload) as WardPack,
      enabled: row.enabled === 1,
      priority: row.priority,
      importedAt: row.imported_at,
    };
  } catch {
    // 손상된 사전 하나 때문에 나머지를 못 쓰게 만들지 않는다.
    return null;
  }
}

export async function listWardPacks(): Promise<StoredPack[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PackRow>(
    "SELECT * FROM ward_packs ORDER BY priority, imported_at",
  );
  return rows.map(toStoredPack).filter((p): p is StoredPack => p !== null);
}

/** 사전에 실제로 실릴 것들. 우선순위 오름차순 — 뒤에 오는 것이 이긴다. */
export async function enabledWardPacks(): Promise<WardPack[]> {
  return (await listWardPacks()).filter((p) => p.enabled).map((p) => p.pack);
}

export async function saveWardPack(
  pack: WardPack,
  options: { enabled?: boolean; priority?: number; now?: number } = {},
): Promise<void> {
  const db = await getDb();
  const now = options.now ?? Date.now();
  await db.runAsync(
    `INSERT INTO ward_packs
       (id, name, hospital, ward, payload, enabled, priority, updated_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       hospital = excluded.hospital,
       ward = excluded.ward,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
    [
      pack.id,
      pack.name,
      pack.hospital ?? null,
      pack.ward ?? null,
      JSON.stringify(pack),
      options.enabled === false ? 0 : 1,
      options.priority ?? 0,
      pack.updatedAt || now,
      now,
    ],
  );
}

export async function setWardPackEnabled(id: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE ward_packs SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
}

export async function deleteWardPack(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM ward_packs WHERE id = ?", [id]);
  await db.runAsync("DELETE FROM pending_corrections WHERE source = ?", [id]);
}

// ── 확인 대기 치환 규칙 ─────────────────────────────────

export interface PendingCorrection extends PackCorrection {
  key: string;
  source: string;
  addedAt: number;
}

export async function addPendingCorrections(
  corrections: readonly PackCorrection[],
  source: string,
  now = Date.now(),
): Promise<void> {
  if (corrections.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const c of corrections) {
      await db.runAsync(
        `INSERT INTO pending_corrections (key, from_text, to_text, source, count, added_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
        [`${c.from}|${c.to}`, c.from, c.to, source, c.count ?? 1, now],
      );
    }
  });
}

export async function listPendingCorrections(): Promise<PendingCorrection[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    key: string;
    from_text: string;
    to_text: string;
    source: string;
    count: number;
    added_at: number;
  }>("SELECT * FROM pending_corrections ORDER BY count DESC, added_at");
  return rows.map((r) => ({
    key: r.key,
    from: r.from_text,
    to: r.to_text,
    source: r.source,
    count: r.count,
    addedAt: r.added_at,
  }));
}

/**
 * 대기 중인 치환 규칙을 사람이 승인했다.
 * 여기서 비로소 실제 교정 규칙이 된다. 승인 전까지는 전사에 아무 영향이 없다.
 */
export async function approvePendingCorrection(
  key: string,
  now = Date.now(),
): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ from_text: string; to_text: string; count: number }>(
    "SELECT from_text, to_text, count FROM pending_corrections WHERE key = ?",
    [key],
  );
  if (!row) return;
  await db.runAsync(
    `INSERT INTO correction_rules (key, from_text, to_text, count, last_used_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET count = MAX(correction_rules.count, excluded.count)`,
    [key, row.from_text, row.to_text, Math.max(row.count, 2), now],
  );
  await db.runAsync("DELETE FROM pending_corrections WHERE key = ?", [key]);
}

export async function rejectPendingCorrection(key: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM pending_corrections WHERE key = ?", [key]);
}

// ── 심층 분석 파이프라인 ────────────────────────────────
//
// 배치 제출·폴링 상태를 DB에 남긴다 — 폰 앱은 언제든 죽을 수 있고,
// Anthropic 배치는 몇 분에서 몇 시간 걸린다. 다시 열면 이어받는다.

export interface PipelineJobRow {
  shift_id: string;
  stage: string; // 3a | 3b | 4 | done | error
  batch_id: string | null;
  stage3a: string | null;
  stage3b: string | null;
  error: string | null;
  usage_log: string;
  updated_at: number;
}

export async function getPipelineJob(shiftId: string): Promise<PipelineJobRow | null> {
  const db = await getDb();
  return db.getFirstAsync<PipelineJobRow>(
    "SELECT * FROM pipeline_jobs WHERE shift_id = ?",
    [shiftId],
  );
}

export async function savePipelineJob(job: {
  shiftId: string;
  stage: string;
  batchId?: string | null;
  stage3a?: string | null;
  stage3b?: string | null;
  error?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO pipeline_jobs (shift_id, stage, batch_id, stage3a, stage3b, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(shift_id) DO UPDATE SET
       stage = excluded.stage,
       batch_id = excluded.batch_id,
       stage3a = COALESCE(excluded.stage3a, pipeline_jobs.stage3a),
       stage3b = COALESCE(excluded.stage3b, pipeline_jobs.stage3b),
       error = excluded.error,
       updated_at = excluded.updated_at`,
    [
      job.shiftId,
      job.stage,
      job.batchId ?? null,
      job.stage3a ?? null,
      job.stage3b ?? null,
      job.error ?? null,
      Date.now(),
    ],
  );
}

/** 단계별 usage 를 누적 기록한다 — 나중에 "실제로 얼마 들었나"가 여기서 나온다. */
export async function appendPipelineUsage(shiftId: string, entry: unknown): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ usage_log: string }>(
    "SELECT usage_log FROM pipeline_jobs WHERE shift_id = ?",
    [shiftId],
  );
  const log = row ? (JSON.parse(row.usage_log) as unknown[]) : [];
  log.push(entry);
  await db.runAsync("UPDATE pipeline_jobs SET usage_log = ? WHERE shift_id = ?", [
    JSON.stringify(log),
    shiftId,
  ]);
}

// ── 확인 목록 — 웹 추정은 카드가 아니라 여기로 ─────────

export interface ConfirmationRow {
  id: string;
  shift_id: string;
  source_id: string | null;
  question: string;
  candidate: string | null;
  sources: string;
  resolved: number;
  result: string | null;
  resolve_reason: string | null;
  created_at: number;
  resolved_at: number | null;
}

export async function addConfirmation(input: {
  shiftId: string;
  sourceId?: string;
  question: string;
  candidate?: string;
  sources?: string[];
}): Promise<string> {
  const db = await getDb();
  const id = `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.runAsync(
    `INSERT INTO confirmations (id, shift_id, source_id, question, candidate, sources, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.shiftId,
      input.sourceId ?? null,
      input.question,
      input.candidate ?? null,
      JSON.stringify(input.sources ?? []),
      Date.now(),
    ],
  );
  return id;
}

export async function listConfirmations(shiftId?: string): Promise<ConfirmationRow[]> {
  const db = await getDb();
  return shiftId
    ? db.getAllAsync<ConfirmationRow>(
        "SELECT * FROM confirmations WHERE shift_id = ? ORDER BY created_at",
        [shiftId],
      )
    : db.getAllAsync<ConfirmationRow>(
        "SELECT * FROM confirmations WHERE resolved = 0 ORDER BY created_at DESC LIMIT 200",
      );
}

// ── 변경 이력 — 임상 판단 모드의 수정은 전부 이유와 함께 남는다 ──

async function recordChange(input: {
  target: "card" | "report" | "confirmation";
  targetId: string;
  action: "add" | "update" | "delete" | "resolve";
  before?: unknown;
  after?: unknown;
  reason: string;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO change_history (id, target, target_id, action, before_json, after_json, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      input.target,
      input.targetId,
      input.action,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason,
      Date.now(),
    ],
  );
}

export async function listChangeHistory(
  target?: string,
  targetId?: string,
): Promise<{ id: string; target: string; target_id: string; action: string; reason: string; created_at: number }[]> {
  const db = await getDb();
  if (target && targetId) {
    return db.getAllAsync(
      "SELECT id, target, target_id, action, reason, created_at FROM change_history WHERE target = ? AND target_id = ? ORDER BY created_at DESC",
      [target, targetId],
    );
  }
  return db.getAllAsync(
    "SELECT id, target, target_id, action, reason, created_at FROM change_history ORDER BY created_at DESC LIMIT 100",
  );
}

/** 임상 판단 모드 도구: 카드 수정 (이유 필수, 이전 판 보관). */
export async function clinicalUpdateCard(
  cardId: string,
  front: string,
  back: string,
  reason: string,
): Promise<boolean> {
  const db = await getDb();
  const before = await db.getFirstAsync<{ front: string; back: string }>(
    "SELECT front, back FROM cards WHERE id = ?",
    [cardId],
  );
  if (!before) return false;
  await db.runAsync("UPDATE cards SET front = ?, back = ? WHERE id = ?", [front, back, cardId]);
  await recordChange({
    target: "card",
    targetId: cardId,
    action: "update",
    before,
    after: { front, back },
    reason,
  });
  return true;
}

/** 임상 판단 모드 도구: 카드 삭제 — 실제로는 suspended 로 물려 두고 이력을 남긴다. */
export async function clinicalDeleteCard(cardId: string, reason: string): Promise<boolean> {
  const db = await getDb();
  const before = await db.getFirstAsync<{ front: string; back: string; suspended: number }>(
    "SELECT front, back, suspended FROM cards WHERE id = ?",
    [cardId],
  );
  if (!before) return false;
  await db.runAsync("UPDATE cards SET suspended = 1 WHERE id = ?", [cardId]);
  await recordChange({ target: "card", targetId: cardId, action: "delete", before, reason });
  return true;
}

/**
 * 임상 판단 모드 도구: 카드 추가.
 *
 * source_id 는 필수이고, 최근 심층 분석 결과에 실제로 존재하는 id(C/U/E…)여야
 * 한다 — 근거 없는 카드 생성을 모델 재량이 아니라 코드로 막는다(사양).
 * 존재하지 않으면 null 을 돌려주고 아무것도 만들지 않는다.
 */
export async function clinicalAddCard(input: {
  front: string;
  back: string;
  sourceId?: string;
  shiftId?: string;
  reason: string;
}): Promise<string | null> {
  const db = await getDb();
  const sid = input.sourceId?.trim();
  if (!sid) return null;
  const rows = await db.getAllAsync<{ payload: string }>(
    "SELECT payload FROM shift_reports ORDER BY created_at DESC LIMIT 5",
  );
  const validIds = new Set<string>();
  for (const r of rows) {
    for (const m of r.payload.matchAll(/"id"\s*:\s*"([A-Za-z]+-?\w+)"/g)) validIds.add(m[1]);
  }
  if (!validIds.has(sid)) return null;
  const id = `card_cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO cards (id, kind, front, back, entry_id, shift_id, source_ids, created_at)
     VALUES (?, 'definition', ?, ?, '', ?, ?, ?)`,
    [id, input.front, input.back, input.shiftId ?? null, JSON.stringify(input.sourceId ? [input.sourceId] : []), now],
  );
  await db.runAsync(
    `INSERT INTO review_states (card_id, due_at) VALUES (?, ?)
     ON CONFLICT(card_id) DO NOTHING`,
    [id, now],
  );
  await recordChange({
    target: "card",
    targetId: id,
    action: "add",
    after: { front: input.front, back: input.back, sourceId: input.sourceId },
    reason: input.reason,
  });
  return id;
}

/** 임상 판단 모드 도구: 보고서 구절 교체 — 이전 마크다운 전체를 이력에 보관한다. */
export async function clinicalUpdateReportSection(
  shiftId: string,
  section: string,
  content: string,
  reason: string,
): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ markdown: string }>(
    "SELECT markdown FROM shift_reports WHERE shift_id = ?",
    [shiftId],
  );
  if (!row) return false;
  const heading = `## ${section}`;
  let next: string;
  if (row.markdown.includes(heading)) {
    // 해당 섹션 머리부터 다음 섹션 머리 직전까지 교체한다.
    const start = row.markdown.indexOf(heading);
    const rest = row.markdown.indexOf("\n## ", start + heading.length);
    const tail = rest >= 0 ? row.markdown.slice(rest) : "";
    next = `${row.markdown.slice(0, start)}${heading}\n\n${content.trim()}\n${tail}`;
  } else {
    next = `${row.markdown.trimEnd()}\n\n${heading}\n\n${content.trim()}\n`;
  }
  await db.runAsync("UPDATE shift_reports SET markdown = ? WHERE shift_id = ?", [next, shiftId]);
  await recordChange({
    target: "report",
    targetId: shiftId,
    action: "update",
    before: { markdown: row.markdown },
    after: { section, content },
    reason,
  });
  return true;
}

/** 임상 판단 모드 도구: 확인 목록 해소. */
export async function resolveConfirmation(
  id: string,
  result: string,
  reason: string,
): Promise<boolean> {
  const db = await getDb();
  const before = await db.getFirstAsync<ConfirmationRow>(
    "SELECT * FROM confirmations WHERE id = ?",
    [id],
  );
  if (!before) return false;
  await db.runAsync(
    "UPDATE confirmations SET resolved = 1, result = ?, resolve_reason = ?, resolved_at = ? WHERE id = ?",
    [result, reason, Date.now(), id],
  );
  await recordChange({
    target: "confirmation",
    targetId: id,
    action: "resolve",
    before: { question: before.question, candidate: before.candidate },
    after: { result },
    reason,
  });
  return true;
}
