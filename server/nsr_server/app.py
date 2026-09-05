"""
NSR VPS 서버 — 대화 AI 의 창구(MCP)와 폰의 창구(REST)를 한 프로그램에 둔다.

주소 구성
--------
  GET  /healthz                살아 있는지만 (인증 없음, 숫자도 안 준다)
  POST /ingest                 폰 → 서버. 마스킹된 근무 꾸러미. 기기 토큰 필요
  GET  /pull                   서버 → 폰. 보고서·새 용어 가져가기. 기기 토큰 필요
  POST /pulled                 폰이 "받았다"고 알림. 기기 토큰 필요
  *    /t/<MCP토큰>/mcp         대화 AI 커넥터 주소 (클로드·GPT 공통)

왜 MCP 토큰이 주소 안에 있나
--------------------------
클로드·GPT 의 커넥터는 **주소 하나**만 받는다. 헤더를 넣을 칸이 없다. 정식 방법은
OAuth 지만 개인 서버 하나에 그걸 붙이는 값이 너무 크다. 그래서 추측 불가능한
토큰을 주소에 넣는다 — 주소를 아는 사람만 들어온다.

그 대가를 안다: 주소가 곧 열쇠라 어딘가에 붙여 넣으면 그게 유출이다. 그래서
  - 토큰은 32자 이상, 손으로 못 외울 길이로 만든다
  - 새면 환경변수만 갈아 끼우고 커넥터 주소를 다시 넣는다
  - 접근 기록에 주소 전체를 남기지 않는다 (아래 로그 설정)

기록에 대하여
------------
본문은 어떤 경우에도 로그에 남기지 않는다. 오류 로그에 전사본이 섞이는 것이 가장
흔한 유출 경로다. 남기는 것은 "몇 문장 들어왔다" 같은 숫자뿐이다.
"""

from __future__ import annotations

import logging
from typing import Any

from mcp.server.mcpserver import MCPServer
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

from .config import Config
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


def build_app(config: Config | None = None, store: Store | None = None) -> Starlette:
    config = config or Config()
    store = store or Store(config.db_path)

    mcp = MCPServer(name="NSR 근무 기록", instructions=INSTRUCTIONS, version="0.1.0")

    # ── 대화 AI 가 쓰는 도구 ───────────────────────────────

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

    @mcp.tool()
    def add_term(entry: str, meaning: str, note: str = "") -> str:
        """
        병동 사전에 새 말을 넣는다. 폰이 가져가서 전사 교정에 쓴다.

        환자 이름·병실처럼 사람을 가리키는 말은 넣지 않는다. 넣는 것은 병동에서
        쓰는 용어와 줄임말이다 ("노티", "바이탈", "폴리").
        """
        if not entry.strip() or not meaning.strip():
            return "말과 뜻을 둘 다 적어야 넣을 수 있습니다."
        store.put_term(entry, meaning, note or None)
        return f"'{entry.strip()}' 을(를) 사전에 넣었습니다. 폰이 다음에 가져갑니다."

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

    # ── 폰이 쓰는 주소 ────────────────────────────────────

    def device_ok(request: Request) -> bool:
        header = request.headers.get("authorization", "")
        return header == f"Bearer {config.device_token}"

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
        sentences = bundle.get("sentences") or []
        leftover = screen_bundle([str(s.get("text", "")) for s in sentences])
        if leftover:
            # 무엇이 몇 건인지만 알려 준다. 값은 돌려주지 않는다.
            return JSONResponse(
                {"error": "가려지지 않은 개인정보가 남아 있습니다.", "found": leftover},
                status_code=422,
            )

        n = store.put_shift(bundle)
        for t in bundle.get("terms") or []:
            if t.get("entry") and t.get("meaning"):
                store.put_term(t["entry"], t["meaning"], t.get("note"), source="phone")
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
        store.mark_pulled(list(body.get("shiftIds") or []), list(body.get("entries") or []))
        return JSONResponse({"ok": True})

    # MCP 창구는 추측 불가능한 주소 밑에 둔다. 클로드·GPT 가 같은 주소로 붙는다.
    mcp_app = mcp.streamable_http_app()
    app = Starlette(
        routes=[
            Route("/healthz", healthz),
            Route("/ingest", ingest, methods=["POST"]),
            Route("/pull", pull, methods=["GET"]),
            Route("/pulled", pulled, methods=["POST"]),
            Mount(f"/t/{config.mcp_token}", app=mcp_app),
        ],
        lifespan=lambda _: mcp.session_manager.run(),
    )
    app.state.store = store
    app.state.config = config
    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    config = Config()
    app = build_app(config)
    print(f"NSR 서버 시작 — http://{config.host}:{config.port}")
    print(f"커넥터 주소: https://<도메인>/t/{config.mcp_token[:6]}…/mcp/")
    # 접근 로그를 끈다 — 주소에 토큰이 들어 있어 로그에 남으면 그게 유출이다.
    uvicorn.run(app, host=config.host, port=config.port, access_log=False)


if __name__ == "__main__":
    main()
