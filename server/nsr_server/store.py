"""
보관소 — SQLite 한 파일.

무엇이 들어오나
--------------
폰이 올린 **마스킹된** 근무 꾸러미(문장·태움 숫자·용어)와, 대화 AI 가 써 넣은
보고서다. 원본 전사본(rawText)과 오디오는 여기 오지 않는다.

무한 보관한다 (docs/08 에서 정함). 지우지 않는 대신 디스크 암호화·접근 제한으로
갚기로 했다. 그래서 이 파일 하나가 곧 사고의 크기다 — 파일 권한을 600 으로 둔다.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS shifts (
  shift_id     TEXT PRIMARY KEY,
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  minutes      INTEGER NOT NULL DEFAULT 0,
  sentences    INTEGER NOT NULL DEFAULT 0,
  taeum_score  INTEGER,
  taeum_level  TEXT,
  received_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sentences (
  shift_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  at_sec     REAL NOT NULL DEFAULT 0,
  speaker    TEXT,
  text       TEXT NOT NULL,
  PRIMARY KEY (shift_id, seq)
);

CREATE TABLE IF NOT EXISTS reports (
  shift_id    TEXT PRIMARY KEY,
  markdown    TEXT NOT NULL,
  written_at  INTEGER NOT NULL,
  pulled_at   INTEGER
);

-- ── OAuth (대화 AI 커넥터 로그인) ────────────────────────
-- 커넥터가 등록하고, 사람이 열쇠로 로그인하고, 그 결과로 받은 토큰이 여기 산다.
-- 재시작해도 다시 로그인하지 않게 파일에 둔다.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id   TEXT PRIMARY KEY,
  info        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  id          TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  expires_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code        TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  expires_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  resource    TEXT,
  expires_at  REAL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS terms (
  entry       TEXT PRIMARY KEY,
  meaning     TEXT NOT NULL,
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'ai',
  written_at  INTEGER NOT NULL,
  pulled_at   INTEGER
);
"""


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        new = not os.path.exists(path)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()
        if new:
            # 남이 읽지 못하게. 무한 보관이라 더 중요하다.
            os.chmod(path, 0o600)

    # ── 폰이 올린다 ────────────────────────────────────────

    def put_shift(self, bundle: dict[str, Any]) -> int:
        """근무 꾸러미 하나를 넣는다. 같은 근무를 다시 올리면 갈아 끼운다."""
        shift_id = str(bundle["shiftId"])
        sentences = bundle.get("sentences") or []
        now = int(time.time())
        taeum = bundle.get("taeum") or {}
        with self.db:
            self.db.execute(
                """INSERT INTO shifts (shift_id, date, code, minutes, sentences,
                                       taeum_score, taeum_level, received_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(shift_id) DO UPDATE SET
                     date=excluded.date, code=excluded.code, minutes=excluded.minutes,
                     sentences=excluded.sentences, taeum_score=excluded.taeum_score,
                     taeum_level=excluded.taeum_level, received_at=excluded.received_at""",
                (
                    shift_id,
                    str(bundle.get("date", "")),
                    str(bundle.get("code", "")),
                    int(bundle.get("minutes") or 0),
                    len(sentences),
                    taeum.get("score"),
                    taeum.get("level"),
                    now,
                ),
            )
            self.db.execute("DELETE FROM sentences WHERE shift_id = ?", (shift_id,))
            self.db.executemany(
                "INSERT INTO sentences (shift_id, seq, at_sec, speaker, text) VALUES (?, ?, ?, ?, ?)",
                [
                    (shift_id, i, float(s.get("t") or 0), s.get("speaker"), str(s.get("text", "")))
                    for i, s in enumerate(sentences)
                ],
            )
        return len(sentences)

    # ── 대화 AI 가 읽는다 ──────────────────────────────────

    def list_shifts(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.db.execute(
            """SELECT s.shift_id, s.date, s.code, s.minutes, s.sentences,
                      (SELECT 1 FROM reports r WHERE r.shift_id = s.shift_id) AS has_report
                 FROM shifts s ORDER BY s.date DESC, s.shift_id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [
            {
                "shiftId": r["shift_id"],
                "date": r["date"],
                "duty": r["code"],
                "minutes": r["minutes"],
                "sentences": r["sentences"],
                "hasReport": bool(r["has_report"]),
            }
            for r in rows
        ]

    def get_sentences(self, shift_id: str, offset: int = 0, limit: int = 200) -> dict[str, Any]:
        total = self.db.execute(
            "SELECT COUNT(*) AS n FROM sentences WHERE shift_id = ?", (shift_id,)
        ).fetchone()["n"]
        rows = self.db.execute(
            """SELECT seq, at_sec, speaker, text FROM sentences
                WHERE shift_id = ? ORDER BY seq LIMIT ? OFFSET ?""",
            (shift_id, limit, offset),
        ).fetchall()
        return {
            "shiftId": shift_id,
            "total": total,
            "offset": offset,
            "returned": len(rows),
            "nextOffset": offset + len(rows) if offset + len(rows) < total else None,
            "sentences": [
                {
                    "seq": r["seq"],
                    "at": round(r["at_sec"], 1),
                    "speaker": r["speaker"],
                    "text": r["text"],
                }
                for r in rows
            ],
        }

    def taeum_summary(self, limit: int = 12) -> list[dict[str, Any]]:
        """숫자와 등급만. 그 점수를 만든 문장은 여기서 안 준다."""
        rows = self.db.execute(
            """SELECT date, code, taeum_score, taeum_level FROM shifts
                WHERE taeum_score IS NOT NULL ORDER BY date DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [
            {"date": r["date"], "duty": r["code"], "score": r["taeum_score"], "level": r["taeum_level"]}
            for r in rows
        ]

    # ── 보고서 ────────────────────────────────────────────

    def put_report(self, shift_id: str, markdown: str) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO reports (shift_id, markdown, written_at) VALUES (?, ?, ?)
                   ON CONFLICT(shift_id) DO UPDATE SET
                     markdown=excluded.markdown, written_at=excluded.written_at, pulled_at=NULL""",
                (shift_id, markdown, int(time.time())),
            )

    def get_report(self, shift_id: str) -> str | None:
        row = self.db.execute(
            "SELECT markdown FROM reports WHERE shift_id = ?", (shift_id,)
        ).fetchone()
        return row["markdown"] if row else None

    def pending_for_phone(self) -> dict[str, Any]:
        """폰이 아직 안 가져간 것 — 보고서와 새 용어."""
        reports = self.db.execute(
            "SELECT shift_id, markdown FROM reports WHERE pulled_at IS NULL"
        ).fetchall()
        terms = self.db.execute(
            "SELECT entry, meaning, note FROM terms WHERE pulled_at IS NULL"
        ).fetchall()
        return {
            "reports": [{"shiftId": r["shift_id"], "markdown": r["markdown"]} for r in reports],
            "terms": [
                {"entry": t["entry"], "meaning": t["meaning"], "note": t["note"]} for t in terms
            ],
        }

    def mark_pulled(self, shift_ids: list[str], entries: list[str]) -> None:
        now = int(time.time())
        with self.db:
            self.db.executemany(
                "UPDATE reports SET pulled_at = ? WHERE shift_id = ?",
                [(now, s) for s in shift_ids],
            )
            self.db.executemany(
                "UPDATE terms SET pulled_at = ? WHERE entry = ?", [(now, e) for e in entries]
            )

    # ── 병동 사전 ─────────────────────────────────────────

    def put_term(self, entry: str, meaning: str, note: str | None, source: str = "ai") -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO terms (entry, meaning, note, source, written_at) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(entry) DO UPDATE SET
                     meaning=excluded.meaning, note=excluded.note,
                     written_at=excluded.written_at, pulled_at=NULL""",
                (entry.strip(), meaning.strip(), (note or "").strip() or None, source, int(time.time())),
            )

    def search_terms(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        like = f"%{query.strip()}%"
        rows = self.db.execute(
            """SELECT entry, meaning, note FROM terms
                WHERE entry LIKE ? OR meaning LIKE ? ORDER BY entry LIMIT ?""",
            (like, like, limit),
        ).fetchall()
        return [{"entry": r["entry"], "meaning": r["meaning"], "note": r["note"]} for r in rows]

    def counts(self) -> dict[str, int]:
        one = lambda sql: self.db.execute(sql).fetchone()[0]  # noqa: E731
        return {
            "shifts": one("SELECT COUNT(*) FROM shifts"),
            "sentences": one("SELECT COUNT(*) FROM sentences"),
            "reports": one("SELECT COUNT(*) FROM reports"),
            "terms": one("SELECT COUNT(*) FROM terms"),
        }

    # ── OAuth ─────────────────────────────────────────────

    def put_oauth_client(self, client_id: str, info: dict[str, Any]) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)
                   ON CONFLICT(client_id) DO UPDATE SET info=excluded.info""",
                (client_id, json.dumps(info), int(time.time())),
            )

    def get_oauth_client(self, client_id: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT info FROM oauth_clients WHERE client_id = ?", (client_id,)
        ).fetchone()
        return json.loads(row["info"]) if row else None

    def put_oauth_pending(self, pending_id: str, payload: dict[str, Any], expires_at: float) -> None:
        with self.db:
            self.db.execute("DELETE FROM oauth_pending WHERE expires_at < ?", (time.time(),))
            self.db.execute(
                """INSERT INTO oauth_pending (id, payload, expires_at) VALUES (?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at""",
                (pending_id, json.dumps(payload), expires_at),
            )

    def take_oauth_pending(self, pending_id: str) -> dict[str, Any] | None:
        """꺼내면서 지운다. 같은 대기표를 두 번 쓰지 못한다."""
        row = self.db.execute(
            "SELECT payload, expires_at FROM oauth_pending WHERE id = ?", (pending_id,)
        ).fetchone()
        if not row:
            return None
        with self.db:
            self.db.execute("DELETE FROM oauth_pending WHERE id = ?", (pending_id,))
        if row["expires_at"] < time.time():
            return None
        return json.loads(row["payload"])

    def put_oauth_code(self, code: str, payload: dict[str, Any]) -> None:
        with self.db:
            self.db.execute("DELETE FROM oauth_codes WHERE expires_at < ?", (time.time(),))
            self.db.execute(
                "INSERT INTO oauth_codes (code, payload, expires_at) VALUES (?, ?, ?)",
                (code, json.dumps(payload), payload["expires_at"]),
            )

    def get_oauth_code(self, code: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT payload FROM oauth_codes WHERE code = ?", (code,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def delete_oauth_code(self, code: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM oauth_codes WHERE code = ?", (code,))

    def put_oauth_token(
        self,
        token: str,
        kind: str,
        client_id: str,
        scopes: list[str],
        expires_at: float | None,
        resource: str | None,
    ) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO oauth_tokens (token, kind, client_id, scopes, resource, expires_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (token, kind, client_id, json.dumps(scopes), resource, expires_at, int(time.time())),
            )

    def get_oauth_token(self, token: str, kind: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT * FROM oauth_tokens WHERE token = ? AND kind = ?", (token, kind)
        ).fetchone()
        if not row:
            return None
        return {
            "token": row["token"],
            "client_id": row["client_id"],
            "scopes": json.loads(row["scopes"]),
            "resource": row["resource"],
            "expires_at": row["expires_at"],
        }

    def delete_oauth_token(self, token: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM oauth_tokens WHERE token = ?", (token,))

    def dump_json(self, obj: Any) -> str:
        return json.dumps(obj, ensure_ascii=False, indent=2)
