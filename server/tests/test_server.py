"""
서버 테스트. `cd server && python -m pytest` 로 돌린다.

두 가지를 지킨다.
  1. 개인정보가 남은 자료는 들어오지 못한다 (2차 검문소).
  2. 폰이 가져간 것은 다시 안 준다 (같은 보고서를 두 번 붙이지 않는다).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nsr_server.screen import screen_bundle, screen_text  # noqa: E402
from nsr_server.store import Store  # noqa: E402


# ── 2차 검문소 ────────────────────────────────────────────


def test_가려진_문장은_통과한다():
    assert screen_text("[이름]님 폴리 확인했어요. [등록번호] 맞아요.") == {}


def test_전화번호를_잡는다():
    assert screen_text("보호자 010-1234-5678 로 연락했어요")["phone"] == 1
    assert screen_text("01012345678 입니다")["phone"] == 1


def test_주민번호를_잡는다():
    assert screen_text("주민번호 900101-1234567 확인")["rrn"] == 1


def test_등록번호처럼_긴_숫자를_잡는다():
    assert screen_text("차트 12345678 보세요")["mrn"] == 1
    # 짧은 숫자는 임상 수치일 수 있어 잡지 않는다 (혈압 120, 체온 36.5)
    assert "mrn" not in screen_text("혈압 120/80, 체온 36.5도")


def test_이메일을_잡는다():
    assert screen_text("nurse@example.com 으로 보냈어요")["email"] == 1


def test_여러_문장을_한번에_훑는다():
    found = screen_bundle(["괜찮아요", "010-1111-2222 예요", "900101-2345678"])
    assert found == {"phone": 1, "rrn": 1}


# ── 보관소 ────────────────────────────────────────────────


def _bundle(shift_id: str = "2026-09-03:E", n: int = 2) -> dict:
    return {
        "shiftId": shift_id,
        "date": shift_id.split(":")[0],
        "code": shift_id.split(":")[1],
        "minutes": 480,
        "masked": True,
        "taeum": {"score": 8, "level": "주의"},
        "sentences": [{"t": i, "speaker": "S1", "text": f"문장 {i}"} for i in range(n)],
    }


def test_근무를_넣고_읽는다(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    assert store.put_shift(_bundle()) == 2
    shifts = store.list_shifts()
    assert shifts[0]["shiftId"] == "2026-09-03:E"
    assert shifts[0]["sentences"] == 2
    assert shifts[0]["hasReport"] is False


def test_같은_근무를_다시_올리면_갈아_끼운다(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.put_shift(_bundle(n=2))
    store.put_shift(_bundle(n=5))
    assert len(store.list_shifts()) == 1
    assert store.get_sentences("2026-09-03:E")["total"] == 5


def test_문장은_페이지로_나눠_준다(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.put_shift(_bundle(n=250))
    first = store.get_sentences("2026-09-03:E", offset=0, limit=100)
    assert first["returned"] == 100
    assert first["nextOffset"] == 100
    last = store.get_sentences("2026-09-03:E", offset=200, limit=100)
    assert last["returned"] == 50
    assert last["nextOffset"] is None


def test_태움은_숫자만_준다(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.put_shift(_bundle())
    row = store.taeum_summary()[0]
    assert row == {"date": "2026-09-03", "duty": "E", "score": 8, "level": "주의"}
    # 점수를 만든 문장은 이 길로 나가지 않는다
    assert "text" not in row and "sentences" not in row


def test_폰이_가져간_것은_다시_안_준다(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.put_shift(_bundle())
    store.put_report("2026-09-03:E", "# 보고서")
    store.put_term("노티", "보고하기", None)

    pending = store.pending_for_phone()
    assert len(pending["reports"]) == 1 and len(pending["terms"]) == 1

    store.mark_pulled(["2026-09-03:E"], ["노티"])
    after = store.pending_for_phone()
    assert after["reports"] == [] and after["terms"] == []


def test_보고서를_고쳐_쓰면_폰이_다시_가져간다(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.put_shift(_bundle())
    store.put_report("2026-09-03:E", "# 첫 판")
    store.mark_pulled(["2026-09-03:E"], [])
    store.put_report("2026-09-03:E", "# 고친 판")
    pending = store.pending_for_phone()
    assert pending["reports"][0]["markdown"] == "# 고친 판"


def test_사전을_찾는다(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.put_term("폴리", "유치도뇨관", "foley")
    store.put_term("노티", "보고하기", None)
    assert [t["entry"] for t in store.search_terms("폴리")] == ["폴리"]
    assert [t["entry"] for t in store.search_terms("보고")] == ["노티"]


def test_파일_권한은_주인만(tmp_path):
    path = str(tmp_path / "t.db")
    Store(path)
    assert oct(os.stat(path).st_mode)[-3:] == "600"


# ── 프록시 뒤에서 살아남기 ─────────────────────────────────
#
# SDK 는 streamable_http_app(host="127.0.0.1") 이라는 고정 기본값을 보고 DNS
# 리바인딩 보호를 자동으로 켠다. 그러면 허용 목록이 로컬 주소뿐이라 nginx·caddy 가
# 넘긴 진짜 도메인 Host 가 421 로 막힌다. 실제로 겪은 사고라 시험으로 못박는다.


def _config(public_host: str = "nsr.example.com", origins: str = ""):
    import importlib

    os.environ["NSR_MCP_TOKEN"] = "a" * 40
    os.environ["NSR_DEVICE_TOKEN"] = "b" * 40
    os.environ["NSR_PUBLIC_HOST"] = public_host
    os.environ["NSR_ALLOWED_ORIGINS"] = origins
    config_module = importlib.import_module("nsr_server.config")
    return config_module.Config()


def test_도메인을_허용_목록에_넣는다():
    from nsr_server.app import transport_security

    s = transport_security(_config())
    assert s.enable_dns_rebinding_protection is True
    assert "nsr.example.com" in s.allowed_hosts
    assert "nsr.example.com:*" in s.allowed_hosts


def test_커넥터_오리진이_기본으로_들어간다():
    from nsr_server.app import transport_security

    s = transport_security(_config())
    assert "https://claude.ai" in s.allowed_origins
    assert "https://chatgpt.com" in s.allowed_origins


def test_오리진을_직접_적으면_그것만_쓴다():
    from nsr_server.app import transport_security

    s = transport_security(_config(origins="https://claude.ai, https://내회사.example"))
    assert s.allowed_origins == ["https://claude.ai", "https://내회사.example"]


def test_별표는_보호를_끈다():
    from nsr_server.app import transport_security

    assert transport_security(_config("*")).enable_dns_rebinding_protection is False


def test_도메인을_안_적으면_이유를_말하고_멈춘다():
    import pytest

    from nsr_server.app import transport_security

    with pytest.raises(SystemExit) as e:
        transport_security(_config(""))
    assert "NSR_PUBLIC_HOST" in str(e.value)
    assert "421" in str(e.value)


def test_토큰이_짧으면_거부한다():
    import pytest

    os.environ["NSR_MCP_TOKEN"] = "짧다"
    os.environ["NSR_DEVICE_TOKEN"] = "b" * 40
    import importlib

    config_module = importlib.import_module("nsr_server.config")
    with pytest.raises(SystemExit) as e:
        config_module.Config()
    assert "32자" in str(e.value)


def test_시작_문구에_토큰이_안_들어간다():
    """systemd 가 stdout 을 journal 로 받는다. 여기 찍히면 로그에 남는 것이다."""
    import pathlib

    source = pathlib.Path(__file__).resolve().parents[1] / "nsr_server" / "app.py"
    body = source.read_text()
    start = body.index("def main()")
    assert "mcp_token" not in body[start:]
    assert "device_token" not in body[start:]


# ── OAuth (커넥터 로그인) ──────────────────────────────────
#
# 클로드 커넥터는 주소만 넣으면 OAuth 등록부터 시도하고, 등록할 곳이 없으면
# "로그인 서비스에 등록할 수 없습니다"로 멈춘다. 그래서 붙였다. 덤으로 주소가
# 더 이상 열쇠가 아니게 됐다 — 열쇠는 로그인 화면에서 한 번 넣는다.

import asyncio  # noqa: E402

KEY = "K" * 40


def _provider(tmp_path):
    from nsr_server.oauth import NsrOAuthProvider

    store = Store(str(tmp_path / "o.db"))
    return NsrOAuthProvider(store, KEY, "nsr.example.com"), store


def _pending(provider, store):
    """authorize 를 거쳐 대기표 하나를 만든다."""
    from mcp.server.auth.provider import AuthorizationParams
    from mcp.shared.auth import OAuthClientInformationFull
    from pydantic import AnyUrl

    client = OAuthClientInformationFull(
        client_id="c1", redirect_uris=[AnyUrl("https://claude.ai/cb")], token_endpoint_auth_method="none"
    )
    asyncio.run(provider.register_client(client))
    url = asyncio.run(
        provider.authorize(
            client,
            AuthorizationParams(
                state="xyz",
                scopes=[],
                code_challenge="chal",
                redirect_uri=AnyUrl("https://claude.ai/cb"),
                redirect_uri_provided_explicitly=True,
            ),
        )
    )
    return client, url.split("p=")[1]


def test_로그인_화면으로_보낸다(tmp_path):
    provider, store = _provider(tmp_path)
    _, pending = _pending(provider, store)
    assert pending  # 곧바로 코드를 주지 않는다 — 사람이 열쇠를 대야 한다


def test_열쇠가_맞아야_코드를_준다(tmp_path):
    provider, store = _provider(tmp_path)
    _, pending = _pending(provider, store)
    assert provider.approve(pending, "틀린열쇠") is None
    back = provider.approve(pending, KEY)
    assert back.startswith("https://claude.ai/cb?code=")
    assert "state=xyz" in back


def test_한글_열쇠에도_안_죽는다(tmp_path):
    """compare_digest 는 아스키 아닌 문자열에 TypeError 를 던진다 — 실제로 500 이 났다."""
    provider, store = _provider(tmp_path)
    _, pending = _pending(provider, store)
    assert provider.approve(pending, "한글로 찍어보기") is None


def test_열쇠를_틀려도_다시_해볼_수_있다(tmp_path):
    provider, store = _provider(tmp_path)
    _, pending = _pending(provider, store)
    provider.approve(pending, "틀림")
    assert provider.approve(pending, KEY) is not None  # 대기표가 살아 있다


def test_코드는_한_번만_쓴다(tmp_path):
    provider, store = _provider(tmp_path)
    client, pending = _pending(provider, store)
    code = provider.approve(pending, KEY).split("code=")[1].split("&")[0]
    loaded = asyncio.run(provider.load_authorization_code(client, code))
    assert loaded is not None
    asyncio.run(provider.exchange_authorization_code(client, loaded))
    assert asyncio.run(provider.load_authorization_code(client, code)) is None


def test_받은_토큰으로만_들어온다(tmp_path):
    provider, store = _provider(tmp_path)
    client, pending = _pending(provider, store)
    code = provider.approve(pending, KEY).split("code=")[1].split("&")[0]
    loaded = asyncio.run(provider.load_authorization_code(client, code))
    token = asyncio.run(provider.exchange_authorization_code(client, loaded))

    assert asyncio.run(provider.verify_token(token.access_token)) is not None
    assert asyncio.run(provider.verify_token("가짜토큰")) is None


def test_토큰을_거두면_못_쓴다(tmp_path):
    provider, store = _provider(tmp_path)
    client, pending = _pending(provider, store)
    code = provider.approve(pending, KEY).split("code=")[1].split("&")[0]
    loaded = asyncio.run(provider.load_authorization_code(client, code))
    token = asyncio.run(provider.exchange_authorization_code(client, loaded))
    access = asyncio.run(provider.load_access_token(token.access_token))
    asyncio.run(provider.revoke_token(access))
    assert asyncio.run(provider.verify_token(token.access_token)) is None
