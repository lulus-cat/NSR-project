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

import contextlib
import json
import os
import sqlite3
import threading
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

-- 폰마다 하나씩 발급되는 열쇠. 첫 기기는 그냥 이어지고(기기가 없을 때만 문이
-- 열린다), 그 뒤로는 이미 이어진 기기가 승인해야 발급된다.
-- 사람이 보거나 옮겨 적을 일이 없다 — 앱이 받아 보안 저장소에 넣는다.
CREATE TABLE IF NOT EXISTS device_tokens (
  token        TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- 서버가 기억해야 하는 한 줄짜리 값들. 지금은 복구 번호 하나뿐이다.
CREATE TABLE IF NOT EXISTS server_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
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


def _num(value: Any) -> float:
    """
    숫자로 받는다. 아니면 0 — **값을 예외에 싣지 않는다.**

    `float("환자A 010-1234-5678")` 은 그 문장을 통째로 예외 문구에 넣고, 그게
    트레이스백을 타고 로그에 남는다. 이 저장소가 곳곳에 '본문은 안 남긴다' 라고
    적어 둔 규칙이 그 한 줄로 깨졌다.
    """
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        new = not os.path.exists(path)
        # 연결 하나를 여러 갈래가 함께 쓴다 (폰의 REST 와 MCP 도구는 다른 실에서
        # 돈다). 파이썬 sqlite3 는 트랜잭션이 열려 있는데 또 열려고 하면
        # "cannot start a transaction within a transaction" 으로 죽는다.
        # 그래서 쓰기는 전부 `_write()` 한 문으로 지난다.
        self._lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()
        if new:
            # 남이 읽지 못하게. 무한 보관이라 더 중요하다.
            os.chmod(path, 0o600)

    @contextlib.contextmanager
    def _write(self):
        """쓰기 트랜잭션 하나. 같은 연결에 둘이 겹치지 않게 줄을 세운다."""
        with self._lock, self.db:
            yield

    # ── 폰이 올린다 ────────────────────────────────────────

    def put_shift(self, bundle: dict[str, Any]) -> int:
        """
        근무 꾸러미 하나를 넣는다. 같은 근무를 다시 올리면 갈아 끼운다.

        숫자는 `_num` 으로 받는다. `int(...)`·`float(...)` 을 바로 쓰면 값이 숫자가
        아닐 때 **그 값이 예외 문구에 그대로 실린다** — 그 문구는 트레이스백을 타고
        journal 에 남는다. 전사본 조각이 들어오면 본문이 로그로 새는 길이 된다.
        """
        shift_id = str(bundle["shiftId"])
        sentences = [s for s in (bundle.get("sentences") or []) if isinstance(s, dict)]
        now = int(time.time())
        taeum = bundle.get("taeum")
        taeum = taeum if isinstance(taeum, dict) else {}
        with self._write():
            self.db.execute(
                """INSERT INTO shifts (shift_id, date, code, minutes, sentences,
                                       taeum_score, taeum_level, received_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(shift_id) DO UPDATE SET
                     date=excluded.date, code=excluded.code, minutes=excluded.minutes,
                     sentences=excluded.sentences, taeum_score=COALESCE(excluded.taeum_score, shifts.taeum_score),
                     taeum_level=COALESCE(excluded.taeum_level, shifts.taeum_level), received_at=excluded.received_at""",
                (
                    shift_id,
                    str(bundle.get("date", "")),
                    str(bundle.get("code", "")),
                    int(_num(bundle.get("minutes"))),
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
                    (shift_id, i, _num(s.get("t")), s.get("speaker"), str(s.get("text", "")))
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
        with self._write():
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
            # 폰이 올린 말은 폰에 돌려주지 않는다. 예전에는 돌려줘서, 근무를 보낼
            # 때마다 자기 사전이 "srv-말" 이라는 짝퉁으로 하나씩 더 생겼다.
            "SELECT entry, meaning, note FROM terms WHERE pulled_at IS NULL AND source != 'phone'"
        ).fetchall()
        return {
            "reports": [{"shiftId": r["shift_id"], "markdown": r["markdown"]} for r in reports],
            "terms": [
                {"entry": t["entry"], "meaning": t["meaning"], "note": t["note"]} for t in terms
            ],
        }

    def mark_pulled(self, shift_ids: list[str], entries: list[str]) -> None:
        now = int(time.time())
        with self._write():
            self.db.executemany(
                "UPDATE reports SET pulled_at = ? WHERE shift_id = ?",
                [(now, s) for s in shift_ids],
            )
            self.db.executemany(
                "UPDATE terms SET pulled_at = ? WHERE entry = ?", [(now, e) for e in entries]
            )

    # ── 병동 사전 ─────────────────────────────────────────

    def put_term(self, entry: str, meaning: str, note: str | None, source: str = "ai") -> None:
        with self._write():
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

    # ── 기기 열쇠 ─────────────────────────────────────────

    def put_device_token(self, token: str, email: str, label: str | None = None) -> None:
        with self._write():
            self.db.execute(
                "INSERT OR REPLACE INTO device_tokens (token, email, label, created_at) VALUES (?, ?, ?, ?)",
                (token, email.strip().lower(), (label or "").strip() or None, int(time.time())),
            )

    def device_token_ok(self, token: str) -> bool:
        """
        이 열쇠가 살아 있는가.

        마지막 사용 시각은 **1분에 한 번만** 적는다. 판정은 읽기인데 매번 쓰기
        트랜잭션을 열면, 무한 보관으로 파일이 커졌을 때 잠금 경합이 여기서 먼저
        난다. 화면에 보이는 값은 분 단위라 이 정도면 충분하다.
        """
        if not token:
            return False
        row = self.db.execute(
            "SELECT last_seen_at FROM device_tokens WHERE token = ?", (token,)
        ).fetchone()
        if not row:
            return False
        now = int(time.time())
        if now - int(row["last_seen_at"] or 0) >= 60:
            with self._write():
                self.db.execute(
                    "UPDATE device_tokens SET last_seen_at = ? WHERE token = ?", (now, token)
                )
        return True

    def claim_first_device(self, token: str, label: str) -> bool:
        """
        기기가 하나도 없을 때만 첫 열쇠를 넣는다. **세는 것과 넣는 것이 한 몸이다.**

        예전에는 세기와 넣기가 따로였다. 워커가 하나라 지금은 안전하지만, 그걸
        코드도 유닛 파일도 강제하지 않는다 — `--workers 2` 한 줄이면 두 대가
        동시에 첫 기기가 된다. 여기서 잠가 두면 워커 수와 무관해진다.
        """
        # 문장 하나로 끝낸다. 세고 나서 넣으면 그 사이에 남이 들어올 수 있는데,
        # `WHERE NOT EXISTS` 는 SQLite 가 쓰기 잠금을 쥔 채로 따지므로 갈라지지 않는다.
        with self._write():
            cur = self.db.execute(
                """INSERT INTO device_tokens (token, email, label, created_at)
                   SELECT ?, ?, ?, ?
                   WHERE NOT EXISTS (SELECT 1 FROM device_tokens)""",
                (token, "(앱)", label, int(time.time())),
            )
        return cur.rowcount == 1

    def count_device_tokens(self) -> int:
        """이어진 기기 수. 0 이면 첫 기기가 그냥 들어올 수 있다(처음 한 번만 열리는 문)."""
        row = self.db.execute("SELECT COUNT(*) AS n FROM device_tokens").fetchone()
        return int(row["n"]) if row else 0

    def delete_device_tokens_except(self, keep: str) -> int:
        """이 열쇠만 남기고 나머지를 끊는다. 앱을 지웠다 깔면 죽은 열쇠가 쌓인다."""
        with self._write():
            cur = self.db.execute("DELETE FROM device_tokens WHERE token <> ?", (keep,))
        return cur.rowcount or 0

    def get_meta(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM server_meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def put_meta(self, key: str, value: str) -> None:
        with self._write():
            self.db.execute(
                """INSERT INTO server_meta (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                (key, value),
            )

    def list_device_tokens(self, current: str = "") -> list[dict[str, Any]]:
        """
        어떤 기기가 붙어 있나. **열쇠 자체는 주지 않는다.**

        묻는 쪽의 열쇠와 같은 줄에 `mine` 을 붙인다. 이게 있어야 앱에서 "2대"가
        내 옛 폰인지 남의 폰인지 가릴 수 있다 — 처음 열리는 문의 위험을 갚기로
        한 것이 바로 이 목록이다(docs/08).
        """
        rows = self.db.execute(
            "SELECT token, label, created_at, last_seen_at FROM device_tokens ORDER BY created_at"
        ).fetchall()
        return [
            {
                "label": r["label"],
                "created_at": r["created_at"],
                "last_seen_at": r["last_seen_at"],
                "mine": bool(current) and r["token"] == current,
            }
            for r in rows
        ]

    def put_oauth_client(self, client_id: str, info: dict[str, Any]) -> None:
        with self._write():
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
        with self._write():
            self.db.execute("DELETE FROM oauth_pending WHERE expires_at < ?", (time.time(),))
            self.db.execute(
                """INSERT INTO oauth_pending (id, payload, expires_at) VALUES (?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at""",
                (pending_id, json.dumps(payload), expires_at),
            )

    def peek_oauth_pending(self, pending_id: str) -> bool:
        """지우지 않고 있는지만 본다. 연결 번호가 겹치는지 볼 때 쓴다."""
        row = self.db.execute(
            "SELECT expires_at FROM oauth_pending WHERE id = ?", (pending_id,)
        ).fetchone()
        return bool(row and row["expires_at"] >= time.time())

    def count_oauth_pending(self, prefix: str) -> int:
        """살아 있는 대기표 수. 연결 번호가 너무 많이 열리는 것을 막을 때 쓴다."""
        row = self.db.execute(
            "SELECT COUNT(*) AS n FROM oauth_pending WHERE id LIKE ? AND expires_at >= ?",
            (f"{prefix}%", time.time()),
        ).fetchone()
        return int(row["n"]) if row else 0

    def take_oauth_pending(self, pending_id: str) -> dict[str, Any] | None:
        """꺼내면서 지운다. 같은 대기표를 두 번 쓰지 못한다."""
        row = self.db.execute(
            "SELECT payload, expires_at FROM oauth_pending WHERE id = ?", (pending_id,)
        ).fetchone()
        if not row:
            return None
        with self._write():
            self.db.execute("DELETE FROM oauth_pending WHERE id = ?", (pending_id,))
        if row["expires_at"] < time.time():
            return None
        return json.loads(row["payload"])

    def put_oauth_code(self, code: str, payload: dict[str, Any]) -> None:
        with self._write():
            self.db.execute("DELETE FROM oauth_codes WHERE expires_at < ?", (time.time(),))
            self.db.execute(
                "INSERT INTO oauth_codes (code, payload, expires_at) VALUES (?, ?, ?)",
                (code, json.dumps(payload), payload["expires_at"]),
            )

    def get_oauth_code(self, code: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT payload FROM oauth_codes WHERE code = ?", (code,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def delete_oauth_code(self, code: str) -> None:
        with self._write():
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
        with self._write():
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
        with self._write():
            self.db.execute("DELETE FROM oauth_tokens WHERE token = ?", (token,))

    def dump_json(self, obj: Any) -> str:
        return json.dumps(obj, ensure_ascii=False, indent=2)
