/**
 * 로컬 데이터베이스 스키마.
 *
 * 암호화에 대해
 * ------------
 * expo-sqlite는 기본적으로 SQLCipher를 쓰지 않는다. 즉 DB 파일 자체는 평문이다.
 * 그래서 이 앱은 두 층으로 막는다.
 *
 *   1. OS 파일 보호 — iOS Data Protection(기기 잠금 시 복호화 불가),
 *      Android는 기기 전체 암호화(FBE)에 의존. 백업에서는 제외한다.
 *   2. 앱 잠금 — 생체인증. 화면을 통과하지 않으면 DB를 열지 않는다.
 *
 * 이걸로 충분한가: 잠긴 기기를 잃어버린 경우는 막힌다. 루팅된 기기나
 * 잠금 해제된 상태로 넘어간 기기는 못 막는다. 그래서 보관기간 자동 삭제가 중요하다.
 * 오래된 녹음을 안 지우는 것이 가장 큰 위험이다.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 듀티표. 날짜 하나에 근무 하나.
CREATE TABLE IF NOT EXISTS duty_entries (
  date            TEXT PRIMARY KEY,          -- "2026-08-24" (근무 시작일)
  code            TEXT NOT NULL,             -- D | E | N | OFF | EDU | ANNUAL | SICK | OTHER
  override_start  TEXT,
  override_end    TEXT,
  note            TEXT
);

-- 녹음 파일. 하나의 근무가 여러 파일로 쪼개진다(기본 30분).
CREATE TABLE IF NOT EXISTS recordings (
  id            TEXT PRIMARY KEY,
  shift_id      TEXT,                        -- "2026-08-24:D"
  seq           INTEGER NOT NULL DEFAULT 0,  -- 근무 내 순번
  started_at    INTEGER NOT NULL,            -- epoch ms
  ended_at      INTEGER,
  duration_sec  REAL NOT NULL DEFAULT 0,
  file_uri      TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  -- recording: 녹음 중 / recorded: 완료 / transcribing / transcribed / discarded
  state         TEXT NOT NULL DEFAULT 'recording',
  -- 본인 음성이 없어 통비법상 보관할 수 없다고 판단해 버린 경우 사유를 남긴다.
  discard_reason TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recordings_shift ON recordings(shift_id);
CREATE INDEX IF NOT EXISTS idx_recordings_state ON recordings(state);

-- 전사 세그먼트. raw_text는 절대 덮어쓰지 않는다.
CREATE TABLE IF NOT EXISTS segments (
  id              TEXT PRIMARY KEY,
  recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  shift_id        TEXT,
  start_sec       REAL NOT NULL,
  end_sec         REAL NOT NULL,
  raw_text        TEXT NOT NULL,             -- ASR 원문. 증거로서의 원본
  text            TEXT NOT NULL,             -- 교정본
  speaker_id      TEXT,                      -- "spk_0"
  speaker_role    TEXT,                      -- self | senior | doctor | patient | ...
  asr_confidence  REAL
);
CREATE INDEX IF NOT EXISTS idx_segments_recording ON segments(recording_id);
CREATE INDEX IF NOT EXISTS idx_segments_shift ON segments(shift_id);

-- 교정 이력. 개별 수락/거절이 가능해야 하므로 편집 단위로 남긴다.
CREATE TABLE IF NOT EXISTS edits (
  id          TEXT PRIMARY KEY,
  segment_id  TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  start_pos   INTEGER NOT NULL,
  end_pos     INTEGER NOT NULL,
  from_text   TEXT NOT NULL,
  to_text     TEXT NOT NULL,
  reason      TEXT NOT NULL,                 -- initialism | misheard | phonetic | learned
  entry_id    TEXT,
  confidence  REAL NOT NULL,
  accepted    INTEGER NOT NULL DEFAULT 1     -- 사용자가 거절하면 0
);
CREATE INDEX IF NOT EXISTS idx_edits_segment ON edits(segment_id);

-- 본문에서 인식된 용어 위치. 툴팁과 카드 생성의 앵커.
CREATE TABLE IF NOT EXISTS annotations (
  id          TEXT PRIMARY KEY,
  segment_id  TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  start_pos   INTEGER NOT NULL,
  end_pos     INTEGER NOT NULL,
  surface     TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  via         TEXT NOT NULL,
  confidence  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_segment ON annotations(segment_id);
CREATE INDEX IF NOT EXISTS idx_annotations_entry ON annotations(entry_id);

-- 학습카드
CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                 -- definition | cloze | pitfall | formal
  front       TEXT NOT NULL,
  back        TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  shift_id    TEXT,
  segment_id  TEXT,
  context     TEXT,
  source_ids  TEXT NOT NULL DEFAULT '[]',    -- JSON 배열
  created_at  INTEGER NOT NULL,
  suspended   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cards_entry ON cards(entry_id);

-- 간격 반복 상태 (SM-2)
CREATE TABLE IF NOT EXISTS review_states (
  card_id           TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  repetitions       INTEGER NOT NULL DEFAULT 0,
  interval_days     INTEGER NOT NULL DEFAULT 0,
  ease_factor       REAL NOT NULL DEFAULT 2.5,
  due_at            INTEGER NOT NULL,
  lapses            INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_due ON review_states(due_at);

-- 사용자 교정 학습 규칙
CREATE TABLE IF NOT EXISTS correction_rules (
  key           TEXT PRIMARY KEY,            -- "from|to"
  from_text     TEXT NOT NULL,
  to_text       TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1,
  last_used_at  INTEGER NOT NULL
);

-- 사용자 정의 용어 (병동마다 은어가 다르다)
CREATE TABLE IF NOT EXISTS user_terms (
  id      TEXT PRIMARY KEY,
  payload TEXT NOT NULL                      -- LexiconEntry JSON
);

-- 근무별 태움 지표. 원본 이벤트를 함께 보관해야 나중에 인용을 다시 볼 수 있다.
CREATE TABLE IF NOT EXISTS taeum_scores (
  shift_id    TEXT PRIMARY KEY,
  score       INTEGER NOT NULL,
  level       TEXT NOT NULL,
  payload     TEXT NOT NULL,                 -- TaeumScore JSON
  created_at  INTEGER NOT NULL
);

-- 근무 보고서
CREATE TABLE IF NOT EXISTS shift_reports (
  shift_id    TEXT PRIMARY KEY,
  markdown    TEXT NOT NULL,
  payload     TEXT NOT NULL,                 -- ShiftReport JSON
  created_at  INTEGER NOT NULL
);

-- 키-값 설정
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
