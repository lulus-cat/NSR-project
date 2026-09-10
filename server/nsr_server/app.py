"""
NSR VPS 서버 — 대화 AI 의 창구(MCP)와 폰의 창구(REST)를 한 프로그램에 둔다.

주소 구성
--------
  GET  /healthz                살아 있는지만 (인증 없음, 숫자도 안 준다)
  POST /ingest                 폰 → 서버. 마스킹된 근무 꾸러미. 기기 토큰 필요
  GET  /pull                   서버 → 폰. 보고서·새 용어 가져가기. 기기 토큰 필요
  POST /pulled                 폰이 "받았다"고 알림. 기기 토큰 필요
  *    /mcp                     대화 AI 커넥터 주소 (클로드·GPT 공통)
  GET  /device/door            문이 열려 있나 보기만 한다 (아무것도 발급 안 한다)
  POST /device/link            앱이 잇기를 시작한다 (첫 기기면 바로, 아니면 번호)
  POST /device/link/poll       새 기기가 승인을 기다리며 들여다보는 자리
  POST /device/recover         복구 번호로 잇기 (앱을 다시 깔았을 때)
  GET  /device/state           이어진 기기와 복구 번호. 기기 열쇠 필요
  POST /device/forget-others   이 기기만 남기고 끊기. 기기 열쇠 필요
  POST /connector/approve      폰이 승인한다 — AI 연결과 새 기기 둘 다. 기기 열쇠 필요
  GET  /oauth/login            커넥터 화면 — 번호를 보여 주고 폰의 승인을 기다린다
  GET  /oauth/login/status     그 화면이 2초마다 들여다보는 자리
  *    /.well-known/oauth-*     커넥터가 로그인 방법을 찾아보는 자리 (SDK 가 만든다)
  *    /register /authorize /token   OAuth 절차 (SDK 가 만든다)

왜 OAuth 인가
------------
처음에는 추측 불가능한 토큰을 주소에 넣어 두는 것으로 갔다. 그런데 클로드 커넥터는
주소를 넣으면 **먼저 OAuth 등록을 시도하고**, 등록할 곳이 없으면 "로그인 서비스에
등록할 수 없습니다"로 멈춘다. 인증 없는 서버로 넘어가 주지 않았다.

바꾸고 나니 더 안전해졌다. **주소가 더 이상 열쇠가 아니다.** 주소는 남에게 보여도
되고, 연결은 **폰이 승인**해야 열린다 — 화면에 뜬 여섯 자리 번호를 앱에 넣는 식이다.
사람이 어딘가에 적어 둘 열쇠가 아예 없다. 자세한 절차는 oauth.py 에 적혀 있다.

기록에 대하여
------------
본문은 어떤 경우에도 로그에 남기지 않는다. 오류 로그에 전사본이 섞이는 것이 가장
흔한 유출 경로다. 남기는 것은 "몇 문장 들어왔다" 같은 숫자뿐이다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import json
import secrets
import time
from typing import Any
from urllib.parse import quote

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from pydantic import AnyHttpUrl, BaseModel
from starlette.responses import HTMLResponse

from .config import Config
from .oauth import NsrOAuthProvider
from .link import (
    BAD_RECOVERY_DELAY,
    approve_link,
    first_token,
    issue_token,
    new_link_code,
    poll_link,
    recovery_code,
    use_recovery,
)
from .tiro import TiroError, fetch_paragraphs, list_notes, mask, push_word, word_reject
from .screen import screen_bundle
from .store import Store

log = logging.getLogger("nsr")

INSTRUCTIONS = """\
신규간호사의 근무 기록을 다루는 창구입니다.

여기 있는 문장은 **이미 개인정보를 가린 사본**입니다. 이름은 [이름], 등록번호는
[등록번호] 처럼 바뀌어 있습니다. 가려진 자리를 추측해서 되살리지 마십시오.

분석을 요청받으면 저장소의 규칙을 따릅니다 — 추출 → 검증 → 조사 → 보고서 순서이고,
근거 없는 임상 판단을 쓰지 않으며, 확인이 필요한 것은 '확인필요'로 남깁니다.
보고서는 put_shift_report 로 써 넣으면 폰이 가져갑니다.
"""


def only_digits(value: Any) -> str:
    """
    번호에서 숫자만 남긴다.

    isdigit() 은 전각 '３' 이나 아랍 숫자도 참이다. 그런 글자로 만든 번호는 어떤
    대기표에도 안 맞아서, 맞게 누른 사람이 "번호가 틀렸다"를 보게 된다.
    """
    return "".join(ch for ch in str(value or "") if ch in "0123456789")



# ── 챗지피티 커넥터 규격 ────────────────────────────────────
#
# 개발자 모드가 아닌 챗지피티는 `search` 와 `fetch` 두 도구가 **이 모양 그대로**
# 있는 서버만 받는다. 반환형을 파이단틱으로 적어야 SDK 가 output schema 와
# structuredContent 를 함께 내보낸다 — dict 로 두면 글자만 나가고 챗지피티가
# 결과를 못 읽는다 (실제로 확인했다).
#
# 새로 여는 자료는 없다. 이미 도구로 열어 둔 것(근무 전사본·보고서·병동 사전)에
# 이름표를 붙여 그 규격으로 내주는 것뿐이라 개인정보 경계는 그대로다.


class SearchHit(BaseModel):
    id: str
    title: str
    url: str


class SearchResult(BaseModel):
    results: list[SearchHit]


class FetchResult(BaseModel):
    id: str
    title: str
    text: str
    url: str
    metadata: dict[str, str]


def transport_security(config: Config) -> TransportSecuritySettings:
    """
    프록시 뒤에서 살아남는 설정.

    한때 `NSR_PUBLIC_HOST=*` 로 보호를 통째로 끌 수 있었다. **없앴다.**
    혼자 쓸 때는 "권하지 않음" 으로 족했지만, 이 서버를 남들이 각자 세우기
    시작하면 막힌 사람이 검색해서 제일 먼저 찾는 것이 그 한 줄이다. 끄면
    주소 안의 토큰이 유일한 문지기가 되고, DNS 리바인딩으로 남의 브라우저가
    그 서버를 대신 부를 수 있다. 도메인을 적는 것이 정답이라 그것만 남긴다.
    """
    if not config.public_host or config.public_host == "*":
        raise SystemExit(
            "환경변수 NSR_PUBLIC_HOST 에 바깥에서 부르는 도메인을 넣으십시오.\n"
            "  NSR_PUBLIC_HOST=nsr.example.com\n"
            "'*' 는 받지 않습니다 — 보호가 꺼져 남의 브라우저가 이 서버를 대신\n"
            "부를 수 있습니다(DNS 리바인딩). 도메인을 그대로 적으십시오.\n"
            "이 값이 없으면 커넥터가 421 Invalid Host header 로 막힙니다."
        )
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        # 포트가 붙어 오는 경우도 있어 두 모양을 다 넣는다.
        allowed_hosts=[config.public_host, f"{config.public_host}:*"],
        allowed_origins=config.allowed_origins,
    )


def build_app(config: Config | None = None, store: Store | None = None) -> Starlette:
    config = config or Config()
    # 도메인 검사를 **맨 앞에서** 한다. 아래의 AnyHttpUrl("https://") 이 먼저
    # 터지면 사람은 pydantic 오류만 보고 무엇을 넣어야 하는지 모른다.
    transport_security(config)
    store = store or Store(config.db_path)

    auth = NsrOAuthProvider(store, config.public_host)
    base = f"https://{config.public_host}"
    mcp = MCPServer(
        name="NSR 근무 기록",
        instructions=INSTRUCTIONS,
        version="0.1.0",
        auth_server_provider=auth,
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(base),
            resource_server_url=AnyHttpUrl(f"{base}/mcp"),
            # 커넥터가 스스로 등록하게 둔다. 등록만으로는 아무것도 못 읽는다 —
            # 다음 단계(로그인)에서 열쇠를 못 대면 거기서 끝난다.
            client_registration_options=ClientRegistrationOptions(enabled=True),
        ),
    )

    # ── 대화 AI 가 쓰는 도구 ───────────────────────────────

    # ── 챗지피티 커넥터가 찾는 두 도구 ─────────────────────
    #
    # 클로드는 아래 도구들을 이름으로 골라 쓰지만, 챗지피티는 개발자 모드가
    # 아니면 search/fetch 가 없는 서버를 아예 안 받는다. 둘은 읽기 전용이고,
    # 안쪽은 위 도구들과 같은 자료를 본다.

    def doc_url(doc_id: str) -> str:
        # 인용에 쓰이는 이름표다. 열어도 자료는 안 나온다(/doc 참조) —
        # 주소만 보고 남이 남의 근무를 읽을 수는 없어야 한다.
        # 사전 항목에는 빈칸도 빗금도 들어간다("b/p 체크"). 안 감싸면 주소가 깨진다.
        return f"{base}/doc/{quote(doc_id, safe=':@')}"

    @mcp.tool()
    def search(query: str) -> SearchResult:
        """
        근무 전사본·보고서·병동 사전을 말 하나로 훑는다. 읽기 전용.

        찾은 것마다 id 를 준다. 본문은 그 id 로 fetch 를 불러 읽는다.
        """
        hits = store.search_docs(query, 20)
        return SearchResult(
            results=[
                SearchHit(id=h["id"], title=f"{h['title']} — {h['snippet']}", url=doc_url(h["id"]))
                for h in hits
            ]
        )

    @mcp.tool()
    def fetch(id: str) -> FetchResult:
        """search 가 준 id 로 본문을 읽는다. 읽기 전용."""
        doc = store.fetch_doc(id)
        if doc is None:
            # ToolError 여야 한다. 다른 예외는 SDK 가 '터졌다' 로 보아 모델에게
            # "Error executing tool fetch" 만 주고, 서버 로그에 트레이스백을
            # 남긴다 — 그 안에 id 가 딸려 들어간다. 그래서 **id 를 말에 넣지
            # 않는다.** 이 자리는 INFO 한 줄로만 남는다.
            raise ToolError("그런 자료가 없습니다. search 로 id 를 먼저 찾으십시오.")
        return FetchResult(
            id=id,
            title=doc["title"],
            text=doc["text"],
            url=doc_url(id),
            metadata={"kind": doc["kind"]},
        )

    @mcp.tool()
    def list_shifts(limit: int = 20) -> str:
        """근무 목록을 최근 것부터 준다. 날짜·듀티·길이·문장 수·보고서 유무."""
        return store.dump_json(store.list_shifts(max(1, min(limit, 100))))

    @mcp.tool()
    def get_shift_sentences(shift_id: str, offset: int = 0, limit: int = 200) -> str:
        """
        근무 한 편의 문장을 페이지 단위로 준다 (개인정보를 가린 사본).

        한 번에 다 주지 않는다 — 8시간 근무는 수천 문장이라 한 덩어리로 주면
        대화가 그것만으로 가득 찬다. nextOffset 이 있으면 이어서 부른다.
        """
        return store.dump_json(store.get_sentences(shift_id, max(0, offset), max(1, min(limit, 500))))

    @mcp.tool()
    def search_terms(query: str, limit: int = 20) -> str:
        """병동 사전에서 말을 찾는다. 뜻과 메모를 함께 준다."""
        return store.dump_json(store.search_terms(query, max(1, min(limit, 100))))

    def to_tiro_words(entry: str) -> str:
        """
        배운 말을 티로 단어장에도 올린다. 다음 전사부터 티로가 그 말을 알아듣는다.

        사전 저장은 이미 끝난 뒤라 여기서 실패해도 되돌리지 않는다 — 못 올렸다고
        말만 하고 넘어간다. 폰이 올리는 길(autoPushTiroWords)과 겹쳐도 상관없다.
        이미 있는 말은 티로가 조용히 건너뛴다.
        """
        if not config.tiro_key:
            return ""
        why = word_reject(entry)
        if why:
            return f" 티로 단어장에는 안 올렸습니다 ({why})."
        try:
            push_word(config.tiro_key, entry)
        except TiroError as e:
            return f" 다만 {e}"
        return " 티로 단어장에도 올렸습니다."

    @mcp.tool()
    def add_term(entry: str, meaning: str, note: str = "") -> str:
        """
        병동 사전에 새 말을 넣는다. 폰이 가져가서 전사 교정에 쓰고, 티로 단어장에도
        올라가 다음 전사부터 그 말을 알아듣는다.

        환자 이름·병실처럼 사람을 가리키는 말은 넣지 않는다. 넣는 것은 병동에서
        쓰는 용어와 줄임말이다 ("노티", "바이탈", "폴리").
        """
        entry, meaning = entry.strip(), meaning.strip()
        if not entry or not meaning:
            return "말과 뜻을 둘 다 적어야 넣을 수 있습니다."
        store.put_term(entry, meaning, note or None)
        return f"'{entry}' 을(를) 사전에 넣었습니다. 폰이 다음에 가져갑니다." + to_tiro_words(entry)

    # 화자 이름표 — 앱이 아는 갈래만 받는다. 없는 이름을 넣으면 앱이 조용히 무시한다.
    ROLES = ("self", "senior", "doctor", "patient", "other")

    @mcp.tool()
    def set_speaker_roles(shift_id: str, roles: str) -> str:
        """
        누가 누구인지 정해서 앱에 넘긴다. 폰이 가져가 전사 화면의 이름표를 바꾼다.

        roles 는 JSON 이다 — 기계 이름표에서 갈래로: {"spk_0":"self","spk_1":"senior"}
        갈래는 self(본인)·senior(선배)·doctor(의사)·patient(환자)·other 다섯 뿐이다.
        확실하지 않은 화자는 **넣지 않는다.** 틀리게 붙은 이름표는 안 붙은 것보다 나쁘다.
        """
        try:
            table = json.loads(roles)
        except Exception:
            return "roles 는 JSON 이어야 합니다. 예: {\"spk_0\":\"self\"}"
        if not isinstance(table, dict) or not table:
            return "roles 가 비어 있습니다."
        clean = {
            str(k): str(v) for k, v in table.items() if str(v) in ROLES and str(k).strip()
        }
        if not clean:
            return f"쓸 수 있는 갈래는 {', '.join(ROLES)} 뿐입니다."
        store.put_ai_action(shift_id, "speakers", clean)
        log.info("화자 이름표 %d개 — 폰이 가져갑니다", len(clean))
        return f"화자 {len(clean)}명을 정했습니다. 폰이 다음에 가져갑니다."

    @mcp.tool()
    def put_corrections(shift_id: str, items: str) -> str:
        """
        **사람이 확정한** 전사 교정을 앱에 넘긴다. 폰이 전사본의 그 낱말을 고친다.

        items 는 JSON 배열이다:
          [{"from":"포리","to":"폴리","reason":"misheard","note":"유치도뇨관"}]

        reason 은 misheard(오인식)·initialism(약어)·phonetic(발음)·learned(배운 말).
        낱말 단위로 적는다 — 문장 통째로 바꾸지 않는다.

        **원문은 안 건드린다.** 앱이 교정본만 고치고 원문(raw_text)은 증거로 남긴다.
        사람이 확정하지 않은 것은 여기 넣지 않는다. 화자가 실제로 한 말(은어)은
        고치는 것이 아니다 — 음성인식이 틀린 것만이다.
        """
        try:
            rows = json.loads(items)
        except Exception:
            return "items 는 JSON 배열이어야 합니다."
        if not isinstance(rows, list) or not rows:
            return "고칠 것이 없습니다."
        clean = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            a, b = str(r.get("from", "")).strip(), str(r.get("to", "")).strip()
            # 빈 값이나 같은 값은 앱에서 아무 일도 안 하면서 기록만 남긴다.
            if not a or not b or a == b or len(a) > 40 or len(b) > 40:
                continue
            clean.append(
                {
                    "from": a,
                    "to": b,
                    "reason": str(r.get("reason", "misheard")),
                    "note": str(r.get("note", "")).strip(),
                }
            )
        if not clean:
            return "쓸 수 있는 항목이 없습니다. from·to 를 둘 다 적고, 서로 달라야 합니다."
        store.put_ai_action(shift_id, "corrections", clean)
        log.info("교정 %d개 — 폰이 가져갑니다", len(clean))
        return f"교정 {len(clean)}개를 넘겼습니다. 폰이 다음에 가져가 전사본을 고칩니다."

    # 태움 갈래 — 앱의 규칙 채점이 쓰는 것과 같은 이름이어야 화면에서 짝이 맞는다.
    TAEUM_CATEGORIES = (
        "verbal_abuse",
        "public_humiliation",
        "information_withholding",
        "excessive_workload",
        "threat",
        "exclusion",
    )

    @mcp.tool()
    def set_taeum(shift_id: str, score: int, note: str = "", events: str = "") -> str:
        """
        문장을 다 읽고 매긴 근무 체온을 앱에 넘긴다. 폰이 그 값으로 바꾼다.

        앱의 규칙 채점은 낱말 목록이라 비꼬는 말투와 앞뒤 맥락을 못 보고,
        **화자 이름표가 안 붙어 있으면 아예 0점**이 나온다. 문장을 다 읽었으면
        그 판단을 여기로 넘긴다.

        score 는 0~100 이다. 눈금은 앱과 같다 —
        10 미만 특이사항 없음 · 10 관찰 · 30 주의 · 60 이상 심각.

        events 는 걸린 대목이다(JSON 배열, 없으면 비워도 된다):
          [{"atSec":4127,"category":"verbal_abuse","label":"인격 모독","quote":"짧게"}]

        갈래: verbal_abuse(폭언·인격 모독)·public_humiliation(공개 망신)·
        information_withholding(정보 차단)·excessive_workload(과한 업무)·
        threat(위협)·exclusion(따돌림).

        인용은 **짧게** 적는다. 이 값은 폰으로 돌아가 화면에 그대로 뜬다.
        """
        try:
            score_n = int(score)
        except (TypeError, ValueError):
            return "score 는 0~100 사이의 숫자여야 합니다."
        score_n = max(0, min(100, score_n))
        rows = []
        if events.strip():
            try:
                parsed = json.loads(events)
            except Exception:
                return "events 는 JSON 배열이어야 합니다."
            if not isinstance(parsed, list):
                return "events 는 JSON 배열이어야 합니다."
            for e in parsed:
                if not isinstance(e, dict):
                    continue
                cat = str(e.get("category", ""))
                if cat not in TAEUM_CATEGORIES:
                    continue
                rows.append(
                    {
                        "atSec": float(e.get("atSec") or 0),
                        "category": cat,
                        "label": str(e.get("label", "")).strip() or "확인 필요",
                        "quote": str(e.get("quote", "")).strip()[:120],
                    }
                )
        store.put_ai_action(
            shift_id, "taeum", {"score": score_n, "note": note.strip(), "events": rows}
        )
        log.info("근무 체온 %d점, 대목 %d개 — 폰이 가져갑니다", score_n, len(rows))
        return f"근무 체온 {score_n}점으로 넘겼습니다. 폰이 다음에 가져갑니다."

    @mcp.tool()
    def get_taeum_summary(limit: int = 12) -> str:
        """근무별 태움 점수와 등급. 숫자만 준다 — 그 점수를 만든 문장은 주지 않는다."""
        return store.dump_json(store.taeum_summary(max(1, min(limit, 60))))

    @mcp.tool()
    def get_shift_report(shift_id: str) -> str:
        """이미 써 둔 근무 보고서를 읽는다."""
        return store.get_report(shift_id) or "아직 보고서가 없습니다."

    @mcp.tool()
    def put_shift_report(shift_id: str, markdown: str) -> str:
        """
        근무 보고서를 써 넣는다. 폰이 가져가 근무 기록에 붙인다.

        가려진 자리를 추측해 실명을 되살려 쓰지 않는다.
        """
        if not markdown.strip():
            return "보고서 내용이 비어 있습니다."
        store.put_report(shift_id, markdown)
        return f"{shift_id} 보고서를 저장했습니다. 폰이 다음에 가져갑니다."

    # ── 티로에서 바로 가져오기 ────────────────────────────
    #
    # 대화 AI 가 티로 MCP 를 함께 붙여 두면 노트를 스스로 읽을 수 있다. 그건
    # **안 가려진 원문**이다. 그래서 이 길을 둔다 — AI 는 "가져와"라고만 하고,
    # 받아서 가리는 일은 서버가 한다. AI 가 보는 것은 가려진 사본뿐이다.

    if config.tiro_key:

        @mcp.tool()
        def list_tiro_notes(limit: int = 20) -> str:
            """티로에 있는 녹음 노트 목록. 제목·날짜·길이만 준다 — 글자는 안 준다."""
            try:
                return store.dump_json(list_notes(config.tiro_key, max(1, min(limit, 50))))
            except TiroError as e:
                return str(e)

        @mcp.tool()
        def import_from_tiro(note_guid: str, date: str, duty: str = "D") -> str:
            """
            티로 노트 하나를 가져와 **개인정보를 가린 뒤** 이 서버에 넣는다.

            date 는 2026-09-03 처럼, duty 는 D·E·N 처럼 적는다. 넣고 나면
            get_shift_sentences 로 읽을 수 있다. 원문은 이 서버에 남지 않는다.
            """
            try:
                paragraphs = fetch_paragraphs(config.tiro_key, note_guid)
                if not paragraphs:
                    return "이 노트에는 아직 전사본이 없습니다. 티로에서 다 되었는지 보십시오."
                out = mask(paragraphs, config.repo_root)
            except TiroError as e:
                return str(e)

            segments = out.get("segments", [])
            if not segments:
                locked = out.get("locked", 0)
                return (
                    "티로 무료 한도로 잠긴 노트라 가져올 것이 없습니다."
                    if locked
                    else "이 노트에서 가져올 말이 없습니다."
                )
            shift_id = f"{date}:{duty}"
            # 폰이 이미 올린 근무를 덮어쓰지 않는다. 폰 사본에는 화자 표시와
            # 폰에서만 가능한 가리기(등록해 둔 이름 목록)가 들어 있어서, 서버가
            # 가린 사본으로 갈아 끼우면 그게 손실이다.
            if any(sh.get("shiftId") == shift_id for sh in store.list_shifts(100)):
                return (
                    f"{shift_id} 는 폰이 이미 올린 근무입니다. 다른 듀티로 넣거나, "
                    "폰에서 지운 뒤에 다시 부르십시오."
                )
            n = store.put_shift(
                {
                    "shiftId": shift_id,
                    "date": date,
                    "code": duty,
                    "minutes": round((segments[-1].get("endSec") or 0) / 60),
                    "sentences": [
                        {"t": s.get("startSec", 0), "speaker": s.get("speakerId"), "text": s["text"]}
                        for s in segments
                    ],
                }
            )
            log.info("티로 노트 가져오기 — 문장 %d개", n)  # 본문은 안 남긴다
            note = f"{shift_id} 에 {n}문장을 넣었습니다. 가린 것 {out.get('redacted', 0)}건."
            if out.get("locked"):
                note += f" 잠긴 문단 {out['locked']}개는 뺐습니다."
            return note

    # ── 폰이 쓰는 주소 ────────────────────────────────────

    def device_ok(request: Request) -> bool:
        """
        폰인가.

        두 갈래를 다 받는다 — 앱이 이을 때 **발급된** 열쇠(기기마다 하나)와,
        nsr.env 에 적어 둔 고정 토큰(비상문). 잇기가 깨져도 자료를 올리는 길이
        끊기지 않게 둘 다 둔다.
        """
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            return False
        token = header[7:]
        if secrets.compare_digest(token.encode("utf-8"), config.device_token.encode("utf-8")):
            return True
        return store.device_token_ok(token)

    async def healthz(_: Request) -> PlainTextResponse:
        return PlainTextResponse("ok")

    async def ingest(request: Request) -> JSONResponse:
        if not device_ok(request):
            return JSONResponse({"error": "토큰이 맞지 않습니다."}, status_code=401)
        try:
            bundle: dict[str, Any] = await request.json()
        except Exception:
            return JSONResponse({"error": "본문이 JSON 이 아닙니다."}, status_code=400)

        if not bundle.get("shiftId"):
            return JSONResponse({"error": "shiftId 가 없습니다."}, status_code=400)

        # 1차 관문은 폰이다. 여기는 그것이 돌았는지 확인하는 두 번째 문이다.
        if bundle.get("masked") is not True:
            return JSONResponse(
                {"error": "가리기를 거치지 않은 자료는 받지 않습니다 (masked=true 필요)."},
                status_code=400,
            )
        # 문장만 보면 안 된다. 화자 이름과 사전 항목도 그대로 저장되고, 그대로
        # 대화 AI 에게 나간다 — 예전에는 이 둘이 검문소를 그냥 지나갔다.
        # 모양이 틀리면 **거절한다.** 걸러 내고 200 을 주면 폰은 올렸다고 알고
        # 서버는 0건을 저장한다 — 근무 한 편이 성공 응답과 함께 사라진다.
        # 조용한 자료 손실은 시끄러운 실패보다 늦게 발견된다.
        sentences = bundle.get("sentences") or []
        if not isinstance(sentences, list) or any(not isinstance(x, dict) for x in sentences):
            return JSONResponse(
                {"error": "sentences 는 객체의 배열이어야 합니다."}, status_code=400
            )
        terms_in = bundle.get("terms") or []
        if not isinstance(terms_in, list) or any(not isinstance(x, dict) for x in terms_in):
            return JSONResponse({"error": "terms 는 객체의 배열이어야 합니다."}, status_code=400)
        checked = [str(s.get("text", "")) for s in sentences]
        checked += [str(s.get("speaker", "")) for s in sentences]
        for t in terms_in:
            checked += [str(t.get(k, "")) for k in ("entry", "meaning", "note")]
        leftover = screen_bundle(checked)
        if leftover:
            # 무엇이 몇 건인지만 알려 준다. 값은 돌려주지 않는다.
            return JSONResponse(
                {"error": "가려지지 않은 개인정보가 남아 있습니다.", "found": leftover},
                status_code=422,
            )

        # 여기부터는 예상 못 한 모양이 와도 500 을 내지 않는다. 500 은 트레이스백을
        # 남기고, 그 트레이스백에는 보낸 값이 섞여 들어간다 — 로그에 본문을 남기지
        # 않는다는 규칙이 그 길로 깨진다. 종류만 남기고 400 으로 돌려보낸다.
        try:
            n = store.put_shift(bundle)
            for t in terms_in:
                # 사전은 티로 단어장으로도 나간다. 같은 잣대로 한 번 더 거른다.
                if t.get("entry") and t.get("meaning") and not word_reject(str(t["entry"])):
                    store.put_term(
                        str(t["entry"]), str(t["meaning"]), t.get("note"), source="phone"
                    )
        except Exception as e:
            log.info("근무 꾸러미 저장 실패 — %s", type(e).__name__)  # 값은 안 남긴다
            return JSONResponse(
                {"error": "보낸 자료의 모양이 맞지 않습니다."}, status_code=400
            )
        log.info("근무 꾸러미 저장 — 문장 %d개", n)  # 본문은 안 남긴다
        return JSONResponse({"ok": True, "shiftId": bundle["shiftId"], "sentences": n})

    async def pull(request: Request) -> JSONResponse:
        if not device_ok(request):
            return JSONResponse({"error": "토큰이 맞지 않습니다."}, status_code=401)
        return JSONResponse(store.pending_for_phone())

    async def pulled(request: Request) -> JSONResponse:
        if not device_ok(request):
            return JSONResponse({"error": "토큰이 맞지 않습니다."}, status_code=401)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "본문이 JSON 이 아닙니다."}, status_code=400)
        store.mark_pulled(
            list(body.get("shiftIds") or []),
            list(body.get("entries") or []),
            list(body.get("actions") or []),
        )
        return JSONResponse({"ok": True})

    # ── 폰 잇기 ───────────────────────────────────────────
    #
    # 앱과 서버 둘만으로 잇는다. 왜 이 모양인지는 link.py 에 적어 뒀다.
    # 예전에는 VPS 에서 명령을 돌려 QR 을 만들었는데, 잇고 싶을 때마다 서버에
    # 들어가야 하는 것이 벽이라 지웠다.

    # 서버가 켜진 시각. 첫 기기를 받는 문이 이때부터 잠깐만 열린다.
    started_at = time.monotonic()

    def door_open() -> bool:
        if store.count_device_tokens() > 0:
            return False
        # 0 만 '제한 없음' 이다. 음수(오타)는 닫힌 것으로 본다 — config.py 참고.
        if config.open_minutes == 0:
            return True
        return time.monotonic() - started_at < config.open_minutes * 60

    def bearer(request: Request) -> str:
        header = request.headers.get("authorization", "")
        return header[7:] if header.startswith("Bearer ") else ""

    async def json_body(request: Request) -> dict[str, Any] | None:
        try:
            return dict(await request.json())
        except Exception:
            return None

    async def device_door(request: Request) -> JSONResponse:
        """
        문이 열려 있나 **보기만** 한다. 아무것도 발급하지 않는다.

        POST 로 확인하다가 열쇠를 받아 가는 사고가 실제로 났다 — 서버를 점검하던
        쪽의 curl 이 첫 기기 자리를 두 번 차지했다. 확인은 이 주소로 한다.
        """
        return JSONResponse({"open": door_open(), "devices": store.count_device_tokens()})

    async def device_link(request: Request) -> JSONResponse:
        """
        잇기 시작.

        이어진 기기가 하나도 없고 **문이 아직 열려 있으면** 그대로 열쇠를 준다
        (처음 한 번만 열리는 문). 기기가 있으면 여섯 자리 번호를 주고, 이미 이어진
        기기의 승인을 기다린다.

        문에 시간을 건 이유: 도메인은 인증서 기록으로 공개된다. 서버를 세워 두고
        며칠 뒤에 폰을 이으면, 그 며칠 내내 도메인을 아는 누구나 먼저 붙을 수 있다.
        """
        if store.count_device_tokens() == 0:
            if not door_open():
                log.info("첫 기기 문이 닫혀 있다 — 다시 켜야 열린다")
                return JSONResponse(
                    {"error": "서버를 다시 켠 뒤에 이어 주십시오."}, status_code=403
                )
            # 세기와 넣기를 한 몸으로 한다. 따로 하면 워커가 둘일 때 두 대가
            # 동시에 첫 기기가 된다 (store.claim_first_device).
            first = first_token(store, "처음 이은 기기")
            if first:
                log.info("첫 기기 연결 — 이제 문이 닫힌다")
                return JSONResponse({"open": True, **first})
        try:
            ticket = new_link_code(store)
        except RuntimeError as e:
            return JSONResponse({"error": str(e)}, status_code=429)
        # code 는 사람이 옮겨 적는 여섯 자리, poll 은 이 기기만 아는 쪽지다.
        return JSONResponse({"open": False, **ticket}, status_code=202)

    async def device_link_poll(request: Request) -> JSONResponse:
        """새 기기가 몇 초마다 묻는 자리. 승인 전에는 404 다."""
        body = await json_body(request)
        if body is None:
            return JSONResponse({"error": "본문이 JSON 이 아닙니다."}, status_code=400)
        code = only_digits(body.get("code"))
        poll = str(body.get("poll", ""))
        got = poll_link(store, code, poll) if len(code) == 6 else None
        if not got:
            return JSONResponse({"waiting": True}, status_code=404)
        log.info("새 기기 연결 — 승인으로")
        return JSONResponse(got)

    async def device_recover(request: Request) -> JSONResponse:
        """복구 번호를 열쇠로 바꾼다. 앱을 지웠다 다시 깔았을 때 쓴다."""
        body = await json_body(request)
        if body is None:
            return JSONResponse({"error": "본문이 JSON 이 아닙니다."}, status_code=400)
        got = use_recovery(store, str(body.get("recovery", "")))
        if not got:
            # 잠그지 않고 늦춘다. 잠금은 남이 대신 걸 수 있어서, 아무 값이나 몇 번
            # 넣어 두면 정작 주인이 못 들어온다 (link.py 의 BAD_RECOVERY_DELAY).
            await asyncio.sleep(BAD_RECOVERY_DELAY)
            log.info("복구 번호 실패")
            return JSONResponse({"error": "복구 번호가 맞지 않습니다."}, status_code=400)
        log.info("복구 번호로 기기 연결")
        return JSONResponse(got)

    async def device_state(request: Request) -> JSONResponse:
        """
        이어진 기기 목록과 복구 번호.

        목록을 앱에 보여 주는 이유: '처음 한 번만 열리는 문' 의 유일한 위험이
        남이 먼저 붙는 것이다. 낯선 기기가 한 줄 늘어 있으면 눈에 띈다.
        """
        if not device_ok(request):
            return JSONResponse({"error": "이 폰은 서버에 이어져 있지 않습니다."}, status_code=401)
        return JSONResponse(
            {
                "devices": store.list_device_tokens(bearer(request)),
                "recovery": recovery_code(store),
            }
        )

    async def device_forget_others(request: Request) -> JSONResponse:
        """이 기기만 남기고 끊는다. 앱을 지웠다 깔기를 되풀이하면 죽은 열쇠가 쌓인다."""
        token = bearer(request)
        # nsr.env 의 비상 토큰으로는 못 한다. 그 토큰은 표에 없어서 '나만 남기기'가
        # 곧 '전부 지우기' 가 되고, 멀쩡히 쓰던 폰이 끊긴다.
        if not store.device_token_ok(token):
            return JSONResponse(
                {"error": "이어진 기기의 열쇠로만 할 수 있습니다."}, status_code=401
            )
        removed = store.delete_device_tokens_except(token)
        log.info("기기 정리 — %d개 끊음", removed)
        return JSONResponse({"removed": removed})

    def clean_code(raw: str) -> str | None:
        """커넥터 대기표는 우리가 만든 모양(URL 안전 문자)만 받는다."""
        return raw if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", raw or "") else None

    # ── 커넥터 연결 화면 ──────────────────────────────────
    #
    # 커넥터(클로드·GPT)가 사람을 여기로 보낸다. 이 화면은 아무것도 묻지 않는다 —
    # 여섯 자리 번호를 보여 주고, **폰이 승인할 때까지** 기다린다.
    #
    # 열쇠를 묻지 않는 이유: 화면에 열쇠를 넣게 하면 사람이 그 열쇠를 어딘가에
    # 적어 두게 된다. 번호는 10분이면 사라지고 그 자체로는 힘이 없다. 승인은
    # 이미 이어진 폰(기기 열쇠를 가진 폰)만 할 수 있다.

    async def oauth_login_form(request: Request) -> HTMLResponse:
        pending = clean_code(request.query_params.get("p", "")) or ""
        code = request.query_params.get("c", "")
        if not re.fullmatch(r"\d{6}", code):
            code = ""
        if not pending or not code:
            return HTMLResponse(
                "<!doctype html><meta charset=utf-8>"
                "<p style=\"font:16px system-ui;padding:24px\">"
                "연결 정보가 없어요. 커넥터에서 다시 시작해 주세요.</p>",
                status_code=400,
            )
        spaced = f"{code[:3]} {code[3:]}"
        # </script> 로 빠져나가지 못하게 한 번 더 막는다 (json.dumps 는 안 막는다).
        pending_js = json.dumps(pending).replace("</", "<\\/")
        return HTMLResponse(
            f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NSR 연결</title>
<style>
  body {{ font-family: system-ui, -apple-system, sans-serif; background:#F7F6F3; color:#23211E;
         display:flex; min-height:100vh; margin:0; align-items:center; justify-content:center; }}
  main {{ background:#fff; padding:28px; border-radius:16px; width:min(380px,92vw);
          box-shadow:0 1px 3px rgba(0,0,0,.08); text-align:center; }}
  h1 {{ font-size:18px; margin:0 0 6px; }}
  p {{ font-size:14px; color:#6B6660; margin:0 0 18px; line-height:1.6; }}
  .code {{ font-size:38px; font-weight:800; letter-spacing:6px; margin:18px 0;
           font-variant-numeric:tabular-nums; }}
  .wait {{ font-size:13px; color:#8A857E; }}
</style></head><body><main>
  <h1>폰에서 승인해 주세요</h1>
  <p>NSR 앱 → 설정 → 분석 서버 → <b>승인 번호</b> 에<br>아래 번호를 넣어 주세요.</p>
  <div class="code">{spaced}</div>
  <p class="wait" id="wait">기다리는 중이에요… 10분 안에 해 주세요.</p>
  <p class="wait">폰이 아직 서버에 안 이어져 있으면 먼저 이어야 해요.<br>
     앱 → 설정 → 분석 서버 → <b>잇기</b> 를 누르면 돼요.</p>
<script>
  // 폰이 승인하면 서버가 돌아갈 주소를 놓아 둔다. 2초마다 들여다본다.
  const p = {pending_js};
  let tries = 0;
  const timer = setInterval(async () => {{
    if (++tries > 300) {{ clearInterval(timer);
      document.getElementById('wait').textContent = '시간이 지났어요. 커넥터에서 다시 시작해 주세요.';
      return; }}
    try {{
      const res = await fetch('/oauth/login/status?p=' + encodeURIComponent(p));
      const body = await res.json();
      if (body.back) {{ clearInterval(timer); location.replace(body.back); }}
    }} catch (e) {{ /* 잠깐 끊긴 것은 다음 차례에 다시 본다 */ }}
  }}, 2000);
</script>
</main></body></html>"""
        )

    async def oauth_login_status(request: Request) -> JSONResponse:
        """화면이 2초마다 묻는 자리. 폰이 승인했으면 돌아갈 주소를 준다."""
        pending = request.query_params.get("p", "")
        done = store.take_oauth_pending(f"approved-{pending}") if pending else None
        return JSONResponse({"back": done["back"]} if done else {})

    async def connector_approve(request: Request) -> JSONResponse:
        """
        폰이 여섯 자리 번호를 승인한다. 이어진 폰만 할 수 있다.

        번호는 두 가지다 — AI 커넥터 화면에 뜬 번호와, 새로 잇는 기기가 띄운 번호.
        앱에서 칸을 둘로 나누면 사람이 어느 칸인지 헷갈린다. 서버가 둘 다 보고
        맞는 쪽을 연다. 번호를 만들 때 양쪽이 겹치지 않게 해 둔다(link.py).
        """
        if not device_ok(request):
            return JSONResponse({"error": "이 폰은 서버에 이어져 있지 않습니다."}, status_code=401)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "본문이 JSON 이 아닙니다."}, status_code=400)
        code = only_digits(body.get("code"))
        if len(code) != 6:
            return JSONResponse({"error": "여섯 자리 번호를 넣어 주십시오."}, status_code=400)
        if auth.approve_from_phone(code):
            log.info("AI 연결 승인 — 폰이 열었다")
            return JSONResponse({"ok": True, "kind": "ai"})
        if approve_link(store, code):
            log.info("새 기기 승인 — 폰이 열었다")
            return JSONResponse({"ok": True, "kind": "device"})
        # 번호가 틀렸는지 시간이 지났는지는 나누지 않는다 — 찍어 보는 사람에게
        # 단서가 된다. 어차피 사람이 할 일은 같다: 처음부터 다시.
        log.info("승인 실패")
        return JSONResponse({"error": "번호가 맞지 않거나 시간이 지났습니다."}, status_code=400)

    # MCP 창구와 OAuth 주소는 SDK 가 만든다. well-known 은 도메인 뿌리에 있어야
    # 커넥터가 찾으므로, 이 앱을 뿌리에 둔다.
    #
    # transport_security 를 반드시 넘겨야 한다. 안 넘기면 SDK 가
    # streamable_http_app(host="127.0.0.1") 이라는 **고정 기본값**을 보고
    # "로컬 서버구나" 판단해 DNS 리바인딩 보호를 자동으로 켠다. 그러면 허용
    # 목록이 127.0.0.1·localhost 뿐이라, nginx·caddy 가 넘긴 진짜 도메인
    # Host 를 421 Invalid Host header 로 거부한다 (실제로 겪은 사고다).
    async def doc_label(request: Request) -> HTMLResponse:
        """
        인용 이름표. **자료를 주지 않는다.**

        챗지피티는 search/fetch 결과마다 url 을 요구하고 그걸 인용에 건다.
        여기서 본문을 내주면 주소만 아는 사람이 남의 근무를 읽게 된다 —
        커넥터는 로그인을 거치지만 이 주소는 안 거친다. 그래서 이름만 되비춘다.
        """
        return HTMLResponse(
            "<!doctype html><meta charset=utf-8>"
            "<title>NSR 기록</title>"
            "<p style='font:16px system-ui;padding:2rem;line-height:1.6'>"
            "이 주소는 인용에 쓰는 이름표입니다.<br>"
            "내용은 이어 둔 AI 커넥터에서만 읽을 수 있습니다.</p>",
            status_code=404,
        )

    mcp_app = mcp.streamable_http_app(transport_security=transport_security(config))

    app = Starlette(
        routes=[
            Route("/healthz", healthz),
            Route("/doc/{rest:path}", doc_label, methods=["GET"]),
            Route("/ingest", ingest, methods=["POST"]),
            Route("/pull", pull, methods=["GET"]),
            Route("/pulled", pulled, methods=["POST"]),
            Route("/device/link", device_link, methods=["POST"]),
            Route("/device/door", device_door, methods=["GET"]),
            Route("/device/link/poll", device_link_poll, methods=["POST"]),
            Route("/device/recover", device_recover, methods=["POST"]),
            Route("/device/state", device_state, methods=["GET"]),
            Route("/device/forget-others", device_forget_others, methods=["POST"]),
            Route("/connector/approve", connector_approve, methods=["POST"]),
            Route("/oauth/login/status", oauth_login_status, methods=["GET"]),
            Route("/oauth/login", oauth_login_form, methods=["GET"]),
            # 나머지는 전부 MCP 앱이 받는다 (mcp · well-known · register · authorize · token)
            Mount("/", app=mcp_app),
        ],
        lifespan=lambda _: mcp.session_manager.run(),
    )
    app.state.store = store
    app.state.config = config
    app.state.auth = auth  # 시험이 번호를 만들 때 쓴다
    # MCP 도구는 build_app 안의 닫힘이라 밖에서 못 부른다. 시험이 값 검사를
    # 확인할 수 있게 이름표를 붙여 둔다 (auth 를 내놓는 것과 같은 이유).
    app.state.tools = {
        "set_speaker_roles": set_speaker_roles,
        "put_corrections": put_corrections,
        "set_taeum": set_taeum,
        "add_term": add_term,
        "search": search,
        "fetch": fetch,
    }
    # 규격 시험이 SDK 가 실제로 내보내는 모양을 본다 (structuredContent·output schema).
    app.state.mcp = mcp
    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    config = Config()
    app = build_app(config)
    print(f"NSR 서버 시작 — http://{config.host}:{config.port}")
    print(f"바깥 도메인: {config.public_host or '(없음 — 시작하지 못합니다)'}")
    # 토큰은 앞자리도 찍지 않는다. systemd 가 stdout 을 journal 로 받으므로
    # 여기 적히는 것은 곧 로그에 남는 것이다. 주소는 nsr.env 를 보고 만든다.
    print(f"커넥터 주소: https://{config.public_host or '<도메인>'}/mcp")
    print("폰 잇기: 앱 → 설정 → 분석 서버 → 잇기")
    print("AI 연결: 커넥터 화면의 여섯 자리 번호를 앱에서 승인")
    # 접근 로그를 끈다 — 주소에 토큰이 들어 있어 로그에 남으면 그게 유출이다.
    uvicorn.run(app, host=config.host, port=config.port, access_log=False)


if __name__ == "__main__":
    main()
