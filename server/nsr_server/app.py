"""
NSR VPS 서버 — 대화 AI 의 창구(MCP)와 폰의 창구(REST)를 한 프로그램에 둔다.

주소 구성
--------
  GET  /healthz                살아 있는지만 (인증 없음, 숫자도 안 준다)
  POST /ingest                 폰 → 서버. 마스킹된 근무 꾸러미. 기기 토큰 필요
  GET  /pull                   서버 → 폰. 보고서·새 용어 가져가기. 기기 토큰 필요
  POST /pulled                 폰이 "받았다"고 알림. 기기 토큰 필요
  *    /mcp                     대화 AI 커넥터 주소 (클로드·GPT 공통)
  GET  /pair/<쪽지>            QR 로 폰 잇기 (VPS 에서 python -m nsr_server.pair)
  GET  /pair/<쪽지>/qr         컴퓨터 화면에 띄우는 큰 QR
  POST /device/claim           폰이 열쇠를 한 번만 받아 간다 (일회용 쪽지)
  POST /connector/approve      폰이 AI 연결을 승인한다 (여섯 자리 번호). 기기 열쇠 필요
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

import logging
import json
import secrets
import time
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
from .pair import svg_qr
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

        두 갈래를 다 받는다 — QR 로 이을 때 **발급된** 열쇠(기기마다 하나)와,
        nsr.env 에 적어 둔 고정 토큰(비상문). QR 이 깨져도 자료를 올리는 길이
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

    # ── QR 로 폰 잇기 ─────────────────────────────────────
    #
    # VPS 에서 `python -m nsr_server.pair` 를 돌리면 쪽지가 하나 생기고 주소 두 개가
    # 나온다. 아래 둘이 그 주소다.
    #
    #   /pair/<쪽지>/qr   컴퓨터 화면에 띄우는 큰 QR
    #   /pair/<쪽지>      폰이 QR 로 여는 자리 → 버튼을 누르면 앱이 열린다
    #
    # 버튼을 두는 이유: 브라우저는 사람이 누르지 않은 앱 열기(nsr://)를 자주
    # 막는다. 302 로 바로 넘기면 아무 일도 안 일어난 것처럼 보인다.

    def pair_page(title: str, body: str) -> HTMLResponse:
        return HTMLResponse(
            f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
  body {{ font-family: system-ui, -apple-system, sans-serif; background:#F7F6F3; color:#23211E;
         display:flex; min-height:100vh; margin:0; align-items:center; justify-content:center; }}
  main {{ background:#fff; padding:28px; border-radius:16px; width:min(420px,92vw);
          box-shadow:0 1px 3px rgba(0,0,0,.08); text-align:center; }}
  h1 {{ font-size:19px; margin:0 0 8px; }}
  p {{ font-size:14px; color:#6B6660; margin:0 0 16px; line-height:1.6; }}
  a.go {{ display:block; padding:15px; font-size:16px; font-weight:700; color:#fff;
          background:#2F6F4E; border-radius:10px; text-decoration:none; }}
  svg {{ width:min(280px,70vw); height:auto; }}
  code {{ font-size:12px; color:#8A857E; word-break:break-all; }}
</style></head><body><main>{body}</main></body></html>"""
        )

    async def pair_qr(request: Request) -> HTMLResponse:
        """컴퓨터 화면에 띄우는 QR. 폰 카메라로 이걸 찍는다."""
        code = request.path_params["code"]
        link = f"https://{config.public_host}/pair/{code}"
        art = svg_qr(link)
        picture = art or f"<p>QR 그림을 못 만들었어요. 아래 주소를 폰에 직접 여세요.</p><code>{link}</code>"
        return pair_page(
            "NSR 폰 잇기",
            f"<h1>폰 카메라로 찍어 주세요</h1>"
            f"<p>찍으면 알림이 뜨고, 누르면 NSR 앱이 열려요.<br>15분 안에 해 주세요.</p>"
            f"{picture}",
        )

    async def pair_open(request: Request) -> HTMLResponse:
        """폰이 QR 로 여는 자리. 버튼을 누르면 앱이 열린다."""
        code = request.path_params["code"]
        return pair_page(
            "NSR 앱 열기",
            f"<h1>NSR 앱을 열까요</h1>"
            f"<p>누르면 앱이 열리면서 이 폰이 서버에 이어져요.</p>"
            f'<a class="go" href="nsr://linked?c={code}">앱 열기</a>',
        )

    async def device_claim(request: Request) -> JSONResponse:
        """앱이 쪽지를 열쇠로 바꾼다. 한 번만 된다."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "본문이 JSON 이 아닙니다."}, status_code=400)
        claim = str(body.get("code", "")).strip()
        pending = store.take_oauth_pending(f"claim-{claim}") if claim else None
        if not pending:
            return JSONResponse(
                {"error": "쪽지가 없거나 시간이 지났습니다. 다시 이어 주십시오."},
                status_code=400,
            )
        # 열쇠는 주우러 온 지금 만든다. 안 주워 가면 아무것도 안 남는다.
        token = secrets.token_urlsafe(32)
        store.put_device_token(token, pending.get("email", "(qr)"), pending.get("label"))
        log.info("기기 연결 — 새 열쇠 발급")
        return JSONResponse({"token": token})

    # ── 커넥터 연결 화면 ──────────────────────────────────
    #
    # 커넥터(클로드·GPT)가 사람을 여기로 보낸다. 이 화면은 아무것도 묻지 않는다 —
    # 여섯 자리 번호를 보여 주고, **폰이 승인할 때까지** 기다린다.
    #
    # 열쇠를 묻지 않는 이유: 화면에 열쇠를 넣게 하면 사람이 그 열쇠를 어딘가에
    # 적어 두게 된다. 번호는 10분이면 사라지고 그 자체로는 힘이 없다. 승인은
    # 이미 이어진 폰(기기 열쇠를 가진 폰)만 할 수 있다.

    async def oauth_login_form(request: Request) -> HTMLResponse:
        pending = request.query_params.get("p", "")
        code = request.query_params.get("c", "")
        if not pending or not code:
            return HTMLResponse(
                "<!doctype html><meta charset=utf-8>"
                "<p style=\"font:16px system-ui;padding:24px\">"
                "연결 정보가 없어요. 커넥터에서 다시 시작해 주세요.</p>",
                status_code=400,
            )
        spaced = f"{code[:3]} {code[3:]}"
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
  <p>NSR 앱 → 설정 → 분석 서버 → <b>AI 연결 승인</b> 에<br>아래 번호를 넣어 주세요.</p>
  <div class="code">{spaced}</div>
  <p class="wait" id="wait">기다리는 중이에요… 10분 안에 해 주세요.</p>
  <p class="wait">폰이 아직 서버에 안 이어져 있으면 먼저 이어야 해요.<br>
     서버에서 <code>python -m nsr_server.pair</code> 로 QR 을 만들어 찍으세요.</p>
<script>
  // 폰이 승인하면 서버가 돌아갈 주소를 놓아 둔다. 2초마다 들여다본다.
  const p = {json.dumps(pending)};
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
        """폰이 번호를 승인한다. 이어진 폰만 할 수 있다."""
        if not device_ok(request):
            return JSONResponse({"error": "이 폰은 서버에 이어져 있지 않습니다."}, status_code=401)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "본문이 JSON 이 아닙니다."}, status_code=400)
        # isdigit() 은 전각 '３' 이나 아랍 숫자도 참이다. 그런 글자로 만든 번호는
        # 어떤 대기표에도 안 맞아서, 맞게 누른 사람이 "번호가 틀렸다"를 본다.
        code = "".join(ch for ch in str(body.get("code", "")) if ch in "0123456789")
        if len(code) != 6:
            return JSONResponse({"error": "여섯 자리 번호를 넣어 주십시오."}, status_code=400)
        if not auth.approve_from_phone(code):
            # 번호가 틀렸는지 시간이 지났는지는 나누지 않는다 — 찍어 보는 사람에게
            # 단서가 된다. 어차피 사람이 할 일은 같다: 커넥터에서 다시 시작.
            log.info("AI 연결 승인 실패")
            return JSONResponse(
                {"error": "번호가 맞지 않거나 시간이 지났습니다."}, status_code=400
            )
        log.info("AI 연결 승인 — 폰이 열었다")
        return JSONResponse({"ok": True})

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
            Route("/pair/{code}", pair_open, methods=["GET"]),
            Route("/pair/{code}/qr", pair_qr, methods=["GET"]),
            Route("/device/claim", device_claim, methods=["POST"]),
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
    print("폰 잇기: python -m nsr_server.pair  (QR)")
    print("AI 연결: 커넥터 화면의 여섯 자리 번호를 앱에서 승인")
    # 접근 로그를 끈다 — 주소에 토큰이 들어 있어 로그에 남으면 그게 유출이다.
    uvicorn.run(app, host=config.host, port=config.port, access_log=False)


if __name__ == "__main__":
    main()
