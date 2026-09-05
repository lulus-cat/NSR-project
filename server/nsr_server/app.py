"""
NSR VPS 서버 — 대화 AI 의 창구(MCP)와 폰의 창구(REST)를 한 프로그램에 둔다.

주소 구성
--------
  GET  /healthz                살아 있는지만 (인증 없음, 숫자도 안 준다)
  POST /ingest                 폰 → 서버. 마스킹된 근무 꾸러미. 기기 토큰 필요
  GET  /pull                   서버 → 폰. 보고서·새 용어 가져가기. 기기 토큰 필요
  POST /pulled                 폰이 "받았다"고 알림. 기기 토큰 필요
  *    /mcp                     대화 AI 커넥터 주소 (클로드·GPT 공통)
  GET  /oauth/login            커넥터를 연결할 때 열쇠를 넣는 화면
  *    /.well-known/oauth-*     커넥터가 로그인 방법을 찾아보는 자리 (SDK 가 만든다)
  *    /register /authorize /token   OAuth 절차 (SDK 가 만든다)

왜 OAuth 인가
------------
처음에는 추측 불가능한 토큰을 주소에 넣어 두는 것으로 갔다. 그런데 클로드 커넥터는
주소를 넣으면 **먼저 OAuth 등록을 시도하고**, 등록할 곳이 없으면 "로그인 서비스에
등록할 수 없습니다"로 멈춘다. 인증 없는 서버로 넘어가 주지 않았다.

바꾸고 나니 더 안전해졌다. **주소가 더 이상 열쇠가 아니다.** 주소는 남에게 보여도
되고, 열쇠는 로그인 화면에서 한 번 넣는다. 화면 공유·캡처로 새는 길이 사라졌다.
자세한 절차는 oauth.py 에 적혀 있다.

기록에 대하여
------------
본문은 어떤 경우에도 로그에 남기지 않는다. 오류 로그에 전사본이 섞이는 것이 가장
흔한 유출 경로다. 남기는 것은 "몇 문장 들어왔다" 같은 숫자뿐이다.
"""

from __future__ import annotations

import logging
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from pydantic import AnyHttpUrl
from starlette.responses import HTMLResponse, RedirectResponse

from .config import Config
from .oauth import NsrOAuthProvider
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


def transport_security(config: Config) -> TransportSecuritySettings:
    """
    프록시 뒤에서 살아남는 설정.

    `NSR_PUBLIC_HOST` 가 `*` 면 보호를 끈다 — 주소 안의 토큰이 유일한 문지기가
    되므로 권하지 않는다. 도메인을 적어 두는 편이 낫다.
    """
    if config.public_host == "*":
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    if not config.public_host:
        raise SystemExit(
            "환경변수 NSR_PUBLIC_HOST 가 비어 있습니다. 바깥에서 부르는 도메인을 넣으십시오.\n"
            "  NSR_PUBLIC_HOST=nsr.example.com\n"
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
    store = store or Store(config.db_path)

    auth = NsrOAuthProvider(store, config.mcp_token, config.public_host)
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

    # ── 로그인 화면 ───────────────────────────────────────
    #
    # 커넥터가 사람을 여기로 보낸다. 묻는 것은 하나다 — 서버 열쇠를 아는가.
    # 한 사람이 쓰는 서버라 계정도 비밀번호도 따로 두지 않는다.

    def login_page(pending: str, message: str = "") -> HTMLResponse:
        note = f'<p class="bad">{message}</p>' if message else ""
        return HTMLResponse(
            f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NSR 연결</title>
<style>
  body {{ font-family: system-ui, -apple-system, sans-serif; background:#F7F6F3; color:#23211E;
         display:flex; min-height:100vh; margin:0; align-items:center; justify-content:center; }}
  form {{ background:#fff; padding:28px; border-radius:16px; width:min(360px,90vw);
          box-shadow:0 1px 3px rgba(0,0,0,.08); }}
  h1 {{ font-size:18px; margin:0 0 6px; }}
  p {{ font-size:14px; color:#6B6660; margin:0 0 18px; line-height:1.5; }}
  .bad {{ color:#B3261E; }}
  input {{ width:100%; padding:12px; font-size:15px; border:1px solid #DDD8D0;
           border-radius:10px; box-sizing:border-box; }}
  button {{ width:100%; margin-top:12px; padding:12px; font-size:15px; font-weight:600;
            color:#fff; background:#2F6F4E; border:0; border-radius:10px; }}
</style></head><body>
<form method="post" action="/oauth/login">
  <h1>NSR 에 연결해요</h1>
  <p>서버 열쇠를 넣어 주세요. 서버의 nsr.env 파일에 있는 NSR_MCP_TOKEN 이에요.</p>
  {note}
  <input type="password" name="key" autofocus autocomplete="off" placeholder="열쇠 붙여넣기">
  <input type="hidden" name="p" value="{pending}">
  <button type="submit">연결하기</button>
</form></body></html>"""
        )

    async def oauth_login_form(request: Request) -> HTMLResponse:
        return login_page(request.query_params.get("p", ""))

    async def oauth_login_submit(request: Request):
        form = await request.form()
        pending = str(form.get("p", ""))
        back = auth.approve(pending, str(form.get("key", "")))
        if not back:
            # 왜 틀렸는지는 나누지 않는다 — 대기표가 없는 건지 열쇠가 틀린 건지
            # 알려 주면 찍어 보는 사람에게 단서가 된다.
            log.info("연결 로그인 실패")
            return login_page(pending, "열쇠가 맞지 않아요. 다시 넣어 주세요.")
        log.info("연결 로그인 성공")
        return RedirectResponse(back, status_code=302)

    # MCP 창구와 OAuth 주소는 SDK 가 만든다. well-known 은 도메인 뿌리에 있어야
    # 커넥터가 찾으므로, 이 앱을 뿌리에 둔다.
    #
    # transport_security 를 반드시 넘겨야 한다. 안 넘기면 SDK 가
    # streamable_http_app(host="127.0.0.1") 이라는 **고정 기본값**을 보고
    # "로컬 서버구나" 판단해 DNS 리바인딩 보호를 자동으로 켠다. 그러면 허용
    # 목록이 127.0.0.1·localhost 뿐이라, nginx·caddy 가 넘긴 진짜 도메인
    # Host 를 421 Invalid Host header 로 거부한다 (실제로 겪은 사고다).
    mcp_app = mcp.streamable_http_app(transport_security=transport_security(config))

    app = Starlette(
        routes=[
            Route("/healthz", healthz),
            Route("/ingest", ingest, methods=["POST"]),
            Route("/pull", pull, methods=["GET"]),
            Route("/pulled", pulled, methods=["POST"]),
            Route("/oauth/login", oauth_login_form, methods=["GET"]),
            Route("/oauth/login", oauth_login_submit, methods=["POST"]),
            # 나머지는 전부 MCP 앱이 받는다 (mcp · well-known · register · authorize · token)
            Mount("/", app=mcp_app),
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
    print(f"바깥 도메인: {config.public_host or '(없음 — 시작하지 못합니다)'}")
    # 토큰은 앞자리도 찍지 않는다. systemd 가 stdout 을 journal 로 받으므로
    # 여기 적히는 것은 곧 로그에 남는 것이다. 주소는 nsr.env 를 보고 만든다.
    print("커넥터 주소: https://<도메인>/t/<NSR_MCP_TOKEN>/mcp  (nsr.env 에서 확인)")
    # 접근 로그를 끈다 — 주소에 토큰이 들어 있어 로그에 남으면 그게 유출이다.
    uvicorn.run(app, host=config.host, port=config.port, access_log=False)


if __name__ == "__main__":
    main()
