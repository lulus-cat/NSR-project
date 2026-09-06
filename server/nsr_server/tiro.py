"""
티로에서 노트를 받아 **가린 뒤** 보관한다.

왜 서버가 직접 받나
------------------
대화 AI 가 티로 MCP 를 함께 붙여 두면 노트를 스스로 읽을 수 있다. 하지만 그건
**안 가려진 원문**이다. 그래서 이 길을 둔다 — AI 는 "가져와"라고만 하고,
받아서 가리는 일은 서버가 한다. AI 는 가려진 사본만 본다.

가리기는 여기서 짜지 않는다
--------------------------
`packages/core` 의 `deidentify` 와 `tiroParagraphsToSegments` 에 이미 있고
테스트가 붙어 있다. 파이썬으로 다시 짜면 구현이 두 벌이 되고, 두 벌은 반드시
어긋난다. `tools/mask-tiro-note.mjs` 를 노드로 한 번 부르고 만다.

한계 (알고 쓴다)
---------------
폰에는 사용자가 등록한 이름 목록(extraTerms)이 있어 호칭 없이 부르는 이름까지
가리지만, 서버에는 그 목록이 없다. 그래서 이 길은 폰 경로보다 약하다.
ponytail: 필요해지면 폰이 그 목록을 올리게 한다.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .screen import screen_text

TIRO_API = "https://api.tiro.ooo"


class TiroError(Exception):
    pass


def _get(path: str, api_key: str) -> Any:
    req = Request(f"{TIRO_API}{path}", headers={"authorization": f"Bearer {api_key}"})
    try:
        with urlopen(req, timeout=30) as res:  # noqa: S310 - 주소가 고정이다
            return json.loads(res.read())
    except Exception as e:  # 티로 응답 본문은 로그에 남기지 않는다
        raise TiroError(f"티로에 물어보지 못했습니다 ({path.split('?')[0]}): {type(e).__name__}") from e


# 소리에서 만들어진 노트만 근무 기록이다 (티로 OpenAPI 의 sourceType 목록).
SOUND_NOTES = ("live-voice", "recording", "offline-mode", "video")


def workspace_guid(api_key: str) -> str | None:
    """이 열쇠가 쓰는 워크스페이스. 목록 주소를 만들 때 필요하다."""
    try:
        return (_get("/v1/external/workspaces/me", api_key) or {}).get("guid")
    except TiroError:
        return None


def list_notes(api_key: str, limit: int = 30) -> list[dict[str, Any]]:
    """
    녹음 노트 목록. 제목·날짜·길이만 준다 — 글자는 여기서 안 준다.

    워크스페이스 주소가 정본이다. `/v1/external/notes` 는 티로가 폐기 예정으로
    표시한 옛 주소라, 워크스페이스를 못 찾았을 때만 쓴다.
    """
    guid = workspace_guid(api_key)
    path = (
        f"/v1/external/workspaces/{guid}/notes?size={limit}"
        if guid
        else f"/v1/external/notes?size={limit}"
    )
    body = _get(path, api_key)
    out = []
    for n in body.get("content", []):
        if not n.get("guid") or n.get("sourceType") not in SOUND_NOTES:
            continue
        out.append(
            {
                "noteGuid": n["guid"],
                "title": (n.get("title") or "제목 없는 노트").strip(),
                "recordedAt": n.get("recordingStartAt") or n.get("createdAt"),
                "minutes": round((n.get("recordingDurationSeconds") or 0) / 60),
            }
        )
    return out


def fetch_paragraphs(api_key: str, note_guid: str) -> list[dict[str, Any]]:
    """노트의 문단 전부. 커서로 나눠 오므로 끝까지 따라간다."""
    out: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(40):  # 500개씩 40쪽 — 티로 상한이 1000이라 500은 안전한 한 입이다
        path = f"/v1/external/notes/{note_guid}/paragraphs?size=500"
        if cursor:
            path += f"&cursor={cursor}"
        body = _get(path, api_key)
        out.extend(body.get("content", []))
        cursor = body.get("nextCursor") or ""
        if not cursor:
            break
    return out


def mask(paragraphs: list[dict[str, Any]], repo_root: str) -> dict[str, Any]:
    """core 의 가리기를 노드로 부른다. 여기서 규칙을 다시 만들지 않는다."""
    base_ms = 0
    for p in paragraphs:
        if p.get("timeFrom"):
            from datetime import datetime

            base_ms = int(datetime.fromisoformat(p["timeFrom"].replace("Z", "+00:00")).timestamp() * 1000)
            break

    script = os.path.join(repo_root, "tools", "mask-tiro-note.mjs")
    if not os.path.exists(script):
        raise TiroError(f"가리기 스크립트가 없습니다: {script}")
    try:
        done = subprocess.run(
            ["node", script],
            input=json.dumps({"paragraphs": paragraphs, "baseMs": base_ms}),
            capture_output=True,
            text=True,
            timeout=120,
            cwd=repo_root,
        )
    except FileNotFoundError as e:
        raise TiroError("서버에 node 가 없습니다. `apt install nodejs` 후 packages/core 를 빌드하십시오.") from e
    if done.returncode != 0:
        # stderr 에 전사본이 섞일 수 있다. 마지막 줄만, 그것도 짧게 옮긴다.
        last = (done.stderr or "").strip().splitlines()[-1:] or ["이유 없음"]
        raise TiroError(f"가리기에 실패했습니다: {last[0][:120]}")
    return json.loads(done.stdout)


# ── 티로 단어장 ────────────────────────────────────────
#
# 올려 둔 말은 **다음 전사부터** 티로가 알아듣는다. 그래서 AI 가 근무 기록에서
# 배운 병동 용어를 여기에 되돌려 넣으면 전사가 갈수록 정확해진다.


def word_reject(entry: str) -> str | None:
    """티로 단어장에 올리면 안 되는 말인가. 안 되면 이유를, 되면 None 을 준다."""
    entry = entry.strip()
    if not entry:
        return "빈 말"
    # 단어장은 사람을 담는 곳이 아니다. 가려진 자리표시자([이름])가 들어 있거나
    # 숫자 모양의 개인정보가 보이면 올리지 않는다.
    if "[" in entry or "]" in entry:
        return "가려진 자리가 들어 있는 말"
    if screen_text(entry):
        return "개인정보로 보이는 말"
    # 티로 제약: 1~63자, 공백 불가. "팁 컬처"처럼 띄어 쓰는 말은 못 올린다.
    if len(entry) > 63:
        return "63자가 넘는 말"
    if any(c.isspace() for c in entry):
        return "띄어쓰기가 있는 말"
    return None


def push_word(api_key: str, entry: str, sub_entry: str | None = None) -> None:
    """낱말 하나를 티로 단어장에 올린다. 이미 있으면(409) 성공으로 친다."""
    word: dict[str, str] = {"entry": entry.strip()}
    if sub_entry and not word_reject(sub_entry):
        word["subEntry"] = sub_entry.strip()
    req = Request(
        f"{TIRO_API}/v1/external/users/me/word-memories/bulk",
        data=json.dumps({"entries": [word]}).encode("utf-8"),
        headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as res:  # noqa: S310 - 주소가 고정이다
            res.read()
    except HTTPError as e:
        if e.code == 409:  # 이미 있는 말 — 실패가 아니다
            return
        raise TiroError(f"티로 단어장에 올리지 못했습니다 (HTTP {e.code})") from e
    except Exception as e:  # 응답 본문은 로그에 남기지 않는다
        raise TiroError(f"티로 단어장에 올리지 못했습니다: {type(e).__name__}") from e
