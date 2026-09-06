"""
서버 테스트. `cd server && python -m pytest` 로 돌린다.

두 가지를 지킨다.
  1. 개인정보가 남은 자료는 들어오지 못한다 (2차 검문소).
  2. 폰이 가져간 것은 다시 안 준다 (같은 보고서를 두 번 붙이지 않는다).
"""

from __future__ import annotations

import os
import sys

import pytest

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

    os.environ["NSR_DEVICE_TOKEN"] = "짧다"
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

def _provider(tmp_path):
    from nsr_server.oauth import NsrOAuthProvider

    store = Store(str(tmp_path / "o.db"))
    return NsrOAuthProvider(store, "nsr.example.com"), store


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
    pending = url.split("p=")[1].split("&")[0]
    code = url.split("c=")[1]
    return client, pending, code


def _approved_back(provider, store, pending, code):
    """폰이 승인한 뒤 화면이 주워 가는 주소."""
    assert provider.approve_from_phone(code)
    return store.take_oauth_pending(f"approved-{pending}")["back"]


def test_곧바로_코드를_주지_않는다(tmp_path):
    provider, store = _provider(tmp_path)
    _, pending, code = _pending(provider, store)
    assert pending and len(code) == 6  # 화면은 번호만 보여 주고 기다린다


def test_폰이_승인해야_코드를_준다(tmp_path):
    provider, store = _provider(tmp_path)
    _, pending, code = _pending(provider, store)
    assert provider.approve_from_phone("000000") is False  # 지어낸 번호는 안 열린다
    back = _approved_back(provider, store, pending, code)
    assert back.startswith("https://claude.ai/cb?code=")
    assert "state=xyz" in back


def test_번호는_한_번만_쓴다(tmp_path):
    provider, store = _provider(tmp_path)
    _, pending, code = _pending(provider, store)
    assert provider.approve_from_phone(code)
    assert provider.approve_from_phone(code) is False


def test_코드는_한_번만_쓴다(tmp_path):
    provider, store = _provider(tmp_path)
    client, pending, number = _pending(provider, store)
    code = _approved_back(provider, store, pending, number).split("code=")[1].split("&")[0]
    loaded = asyncio.run(provider.load_authorization_code(client, code))
    assert loaded is not None
    asyncio.run(provider.exchange_authorization_code(client, loaded))
    assert asyncio.run(provider.load_authorization_code(client, code)) is None


def test_받은_토큰으로만_들어온다(tmp_path):
    provider, store = _provider(tmp_path)
    client, pending, number = _pending(provider, store)
    code = _approved_back(provider, store, pending, number).split("code=")[1].split("&")[0]
    loaded = asyncio.run(provider.load_authorization_code(client, code))
    token = asyncio.run(provider.exchange_authorization_code(client, loaded))

    assert asyncio.run(provider.verify_token(token.access_token)) is not None
    assert asyncio.run(provider.verify_token("가짜토큰")) is None


def test_토큰을_거두면_못_쓴다(tmp_path):
    provider, store = _provider(tmp_path)
    client, pending, number = _pending(provider, store)
    code = _approved_back(provider, store, pending, number).split("code=")[1].split("&")[0]
    loaded = asyncio.run(provider.load_authorization_code(client, code))
    token = asyncio.run(provider.exchange_authorization_code(client, loaded))
    access = asyncio.run(provider.load_access_token(token.access_token))
    asyncio.run(provider.revoke_token(access))
    assert asyncio.run(provider.verify_token(token.access_token)) is None


# ── 티로에서 바로 가져오기 ─────────────────────────────────
#
# 가리기는 파이썬으로 다시 짜지 않는다. core 의 것을 노드로 부른다 —
# 구현이 두 벌이 되면 반드시 어긋난다. 그 호출이 실제로 도는지만 본다.


def test_가리기는_core_를_부른다():
    import os
    import pathlib

    from nsr_server.tiro import mask

    repo = str(pathlib.Path(__file__).resolve().parents[2])
    if not os.path.exists(os.path.join(repo, "packages", "core", "dist")):
        import pytest

        pytest.skip("core 가 빌드되지 않았다 (서버에서는 npm run build 를 먼저 돌린다)")

    out = mask(
        [
            {
                "timeFrom": "2026-09-04T09:00:00Z",
                "timeTo": "2026-09-04T09:00:10Z",
                "transcript": {"content": "김영희님 010-1234-5678 이고 302호예요."},
            },
            {"timeFrom": "2026-09-04T09:01:00Z", "locked": True, "transcript": {"content": "▒▒▒"}},
        ],
        repo,
    )
    text = out["segments"][0]["text"]
    assert "김영희" not in text and "010-1234-5678" not in text and "302호" not in text
    assert out["redacted"] >= 3
    assert out["locked"] == 1  # 잠긴 문단은 버린다


def test_node_가_없으면_이유를_말한다(monkeypatch):
    import subprocess

    from nsr_server.tiro import TiroError, mask

    def boom(*a, **k):
        raise FileNotFoundError()

    monkeypatch.setattr(subprocess, "run", boom)
    import pathlib

    repo = str(pathlib.Path(__file__).resolve().parents[2])
    try:
        mask([{"transcript": {"content": "안녕"}}], repo)
        raise AssertionError("멈췄어야 한다")
    except TiroError as e:
        assert "node" in str(e)


# ── 티로 단어장 ────────────────────────────────────────


def test_병동_용어는_단어장에_올린다():
    from nsr_server.tiro import word_reject

    assert word_reject("노티") is None
    assert word_reject("풀코드") is None


def test_사람을_가리키는_말은_안_올린다():
    from nsr_server.tiro import word_reject

    assert word_reject("[이름]") is not None  # 가려진 자리
    assert word_reject("010-1234-5678") is not None  # 전화번호
    assert word_reject("12345678") is not None  # 등록번호 모양


def test_티로가_못_받는_모양은_거른다():
    from nsr_server.tiro import word_reject

    assert word_reject("팁 컬처") is not None  # 띄어쓰기
    assert word_reject("가" * 64) is not None  # 63자 초과
    assert word_reject("   ") is not None


def test_이미_있는_말은_실패가_아니다(monkeypatch):
    from urllib.error import HTTPError

    from nsr_server import tiro

    def already(*a, **k):
        raise HTTPError("url", 409, "conflict", {}, None)

    monkeypatch.setattr(tiro, "urlopen", already)
    tiro.push_word("열쇠", "노티")  # 던지지 않는다


def test_단어장_오류에_본문을_안_옮긴다(monkeypatch):
    from urllib.error import HTTPError

    from nsr_server import tiro

    def denied(*a, **k):
        raise HTTPError("url", 403, "no", {}, None)

    monkeypatch.setattr(tiro, "urlopen", denied)
    try:
        tiro.push_word("열쇠", "노티")
        raise AssertionError("멈췄어야 한다")
    except tiro.TiroError as e:
        assert "403" in str(e) and "열쇠" not in str(e)


# ── 실제 주소로 (앱이 밟는 순서 그대로) ──────────────────


def _app(tmp_path, monkeypatch):
    import importlib

    monkeypatch.setenv("NSR_DEVICE_TOKEN", "d" * 40)
    monkeypatch.setenv("NSR_DB", str(tmp_path / "app.db"))
    monkeypatch.setenv("NSR_PUBLIC_HOST", "nsr.example.com")
    config_module = importlib.import_module("nsr_server.config")
    app_module = importlib.import_module("nsr_server.app")
    config = config_module.Config()
    return app_module.build_app(config), app_module


def _client(app):
    from starlette.testclient import TestClient

    return TestClient(app, base_url="https://nsr.example.com")


def test_폰과_서버가_같은_잣대인가():
    """
    같은 목록을 폰 시험(packages/core/test/deidentify.test.ts)도 읽는다.

    서버가 더 촘촘하면 폰이 보낸 것이 422 로 되돌아오는데, 앱에는 손으로 다시
    보내는 버튼이 없어서 그 근무는 영영 못 올린다. 폰이 더 촘촘하면 2차 검문소가
    장식이 된다. 어느 쪽으로든 어긋나면 안 된다.
    """
    import json
    import pathlib

    from nsr_server.screen import screen_text

    here = pathlib.Path(__file__).resolve().parents[2]
    corpus = json.loads((here / "packages/core/test/pii-corpus.json").read_text("utf-8"))
    for line in corpus["가려야 하는 것"]:
        assert screen_text(line), line
    for line in corpus["그대로 지나가야 하는 것"]:
        assert not screen_text(line), line
    # 폰이 더 촘촘한 쪽은 서버가 몰라도 된다 — 이미 가려져서 올라온다.
    for line in corpus["폰만 가린다"]["문장"]:
        assert not screen_text(line), line


def test_한국어_문장에서도_2차_검문소가_잡는다():
    """`\\b` 는 파이썬에서 한글을 낱말로 봐서, 조사가 붙은 번호가 다 새어 나갔다."""
    from nsr_server.screen import screen_text

    새는_문장 = [
        "보호자번호는010-1234-5678이에요",
        "주민번호940101-2345678이고",
        "등록번호12345678이에요",
        "메일은hong@test.co.kr이에요",
    ]
    for line in 새는_문장:
        assert screen_text(line), line

    # 평범한 임상 문장은 그대로 지나가야 한다 (여기서 걸리면 못 올린다)
    for line in ["환자A 폴리 확인했어요", "2026년 9월 6일 야간", "혈압 120 80", "산소 2L 넣었어요"]:
        assert not screen_text(line), line


def test_이상한_값이_와도_로그에_안_남는다(tmp_path, monkeypatch):
    """`float("환자A 010-…")` 은 그 문장을 예외 문구에 실어 journal 로 보낸다."""
    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    with _client(app) as c:
        head = {"authorization": f"Bearer {_link(c)['token']}"}
        bad = c.post(
            "/ingest",
            json={
                "shiftId": "2026-09-06:D",
                "date": "2026-09-06",
                "code": "D",
                "masked": True,
                "minutes": "PROBE-VALUE-9911",
                "taeum": "PROBE-TAEUM-7",
                "sentences": [{"t": "PROBE-T-1234", "text": "폴리 확인했어요"}, "문자열"],
            },
            headers=head,
        )
        # 문장 모양이 틀렸으니 거절이다. 걸러 내고 200 을 주면 근무 한 편이
        # 성공 응답과 함께 사라진다 — 조용한 손실이 시끄러운 실패보다 나쁘다.
        assert bad.status_code == 400
        assert "PROBE" not in bad.text
        assert store.counts()["shifts"] == 0

        # 모양이 맞으면 이상한 값이 섞여 있어도 500 없이 들어간다 (값은 안 남는다)
        ok = c.post(
            "/ingest",
            json={
                "shiftId": "2026-09-06:D",
                "date": "2026-09-06",
                "code": "D",
                "masked": True,
                "minutes": "PROBE-VALUE-9911",
                "taeum": "PROBE-TAEUM-7",
                "sentences": [{"t": "PROBE-T-1234", "text": "폴리 확인했어요"}],
            },
            headers=head,
        )
        assert ok.status_code == 200 and "PROBE" not in ok.text
        assert store.counts()["shifts"] == 1


def _link(c):
    """첫 기기를 잇는다 — 기기가 없을 때는 버튼 한 번이 전부다."""
    got = c.post("/device/link", json={})
    assert got.status_code == 200
    return got.json()


def test_첫_기기는_그냥_이어진다(tmp_path, monkeypatch):
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        out = _link(c)
        assert out["open"] is True and out["token"] and out["recovery"]

        # 그 열쇠로 실제로 올릴 수 있다
        res = c.post(
            "/ingest",
            json={
                "shiftId": "2026-09-06:N",
                "date": "2026-09-06",
                "code": "N",
                "masked": True,
                "sentences": [{"t": 0, "text": "[이름]님 폴리 확인했어요."}],
            },
            headers={"authorization": f"Bearer {out['token']}"},
        )
        assert res.status_code == 200


def test_AI_가_정한_것은_폰이_한_번만_가져간다(tmp_path, monkeypatch):
    """화자 이름표와 교정은 읽고 마는 글이 아니라 앱의 자료를 바꾸는 지시다."""
    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    store.put_ai_action("2026-09-06:D", "speakers", {"spk_0": "self", "spk_1": "senior"})
    store.put_ai_action(
        "2026-09-06:D", "corrections", [{"from": "포리", "to": "폴리", "reason": "misheard"}]
    )
    with _client(app) as c:
        head = {"authorization": f"Bearer {_link(c)['token']}"}
        got = c.get("/pull", headers=head).json()
        kinds = {a["kind"]: a for a in got["actions"]}
        assert set(kinds) == {"speakers", "corrections"}
        assert kinds["speakers"]["payload"]["spk_1"] == "senior"
        assert kinds["corrections"]["payload"][0]["to"] == "폴리"

        c.post(
            "/pulled",
            json={"shiftIds": [], "entries": [], "actions": got["actions"]},
            headers=head,
        )
        assert c.get("/pull", headers=head).json()["actions"] == []

        # 다시 쓰면 다시 간다 — 사람이 고쳐 달라고 할 때가 있다
        store.put_ai_action("2026-09-06:D", "speakers", {"spk_0": "senior"})
        assert len(c.get("/pull", headers=head).json()["actions"]) == 1


def test_모르는_화자_갈래와_빈_교정은_안_넘어간다(tmp_path, monkeypatch):
    """틀리게 붙은 이름표는 안 붙은 것보다 나쁘다."""
    import json as _json

    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    tools = app.state.tools

    out = tools["set_speaker_roles"]("2026-09-06:D", _json.dumps({"spk_0": "선배님"}))
    assert "self" in out and store.pending_for_phone()["actions"] == []

    out = tools["set_speaker_roles"](
        "2026-09-06:D", _json.dumps({"spk_0": "self", "spk_9": "왕초보"})
    )
    payload = store.pending_for_phone()["actions"][0]["payload"]
    assert payload == {"spk_0": "self"}

    # from·to 가 같거나 비면 앱에서 아무 일도 안 하면서 기록만 남는다
    out = tools["put_corrections"](
        "2026-09-06:D", _json.dumps([{"from": "폴리", "to": "폴리"}, {"from": "", "to": "x"}])
    )
    assert "쓸 수 있는 항목이 없습니다" in out


def test_첫_문은_동시에_두드려도_한_대만_들어온다(tmp_path):
    """워커가 둘이면 세기와 넣기가 갈라진다. 그래서 한 몸으로 묶었다."""
    from concurrent.futures import ThreadPoolExecutor

    from nsr_server.link import first_token

    store = Store(str(tmp_path / "race.db"))
    with ThreadPoolExecutor(max_workers=8) as pool:
        got = list(pool.map(lambda _: first_token(store, "동시"), range(20)))
    assert sum(1 for g in got if g) == 1
    assert store.count_device_tokens() == 1


def test_설정_오타는_문을_닫는_쪽으로(tmp_path, monkeypatch):
    """음수를 0 으로 접으면 0 이 '제한 없음' 이라 오타가 문을 영영 열어 둔다."""
    import nsr_server.app as app_module

    monkeypatch.setenv("NSR_OPEN_MINUTES", "-5")
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        assert c.get("/device/door").json()["open"] is False
        assert c.post("/device/link", json={}).status_code == 403
    assert app_module.Config().open_minutes == -5


def test_인증할_때마다_쓰지_않는다(tmp_path):
    """읽기 판정이 매번 쓰기 트랜잭션을 열면 파일이 커졌을 때 여기서 먼저 막힌다."""
    store = Store(str(tmp_path / "seen.db"))
    store.put_device_token("열쇠", "(앱)", "폰")
    assert store.device_token_ok("열쇠")
    first = store.list_device_tokens()[0]["last_seen_at"]
    for _ in range(5):
        assert store.device_token_ok("열쇠")
    # 1분 안에는 처음 적은 값 그대로다
    assert store.list_device_tokens()[0]["last_seen_at"] == first

    # 1분이 지나면 다시 적는다
    with store.db:
        store.db.execute("UPDATE device_tokens SET last_seen_at = ? WHERE token = ?", (0, "열쇠"))
    assert store.device_token_ok("열쇠")
    assert store.list_device_tokens()[0]["last_seen_at"] > 0


def test_문은_켠_뒤_잠깐만_열린다(tmp_path, monkeypatch):
    """도메인은 인증서 기록으로 공개된다. 며칠씩 열어 두면 남이 먼저 붙는다."""
    import nsr_server.app as app_module

    monkeypatch.setenv("NSR_OPEN_MINUTES", "30")
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        # 열려 있는지 '보기만' 하는 자리는 아무것도 발급하지 않는다
        peek = c.get("/device/door").json()
        assert peek == {"open": True, "devices": 0}
        assert app.state.store.count_device_tokens() == 0

        # 서른 한 시간 뒤로 시계를 돌린다
        later = app_module.time.monotonic() + 31 * 60
        monkeypatch.setattr(app_module.time, "monotonic", lambda: later)
        assert c.get("/device/door").json()["open"] is False
        refused = c.post("/device/link", json={})
        assert refused.status_code == 403
        assert app.state.store.count_device_tokens() == 0


def test_문에_시간을_안_걸_수도_있다(tmp_path, monkeypatch):
    import nsr_server.app as app_module

    monkeypatch.setenv("NSR_OPEN_MINUTES", "0")
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        later = app_module.time.monotonic() + 999 * 60
        monkeypatch.setattr(app_module.time, "monotonic", lambda: later)
        assert c.post("/device/link", json={}).status_code == 200


def test_문은_한_번만_열린다(tmp_path, monkeypatch):
    """두 번째부터는 번호가 뜨고, 이미 이어진 폰이 승인해야 열쇠가 나온다."""
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        token = _link(c)["token"]
        head = {"authorization": f"Bearer {token}"}

        second = c.post("/device/link", json={})
        assert second.status_code == 202
        code, poll = second.json()["code"], second.json()["poll"]
        assert len(code) == 6 and "token" not in second.json()
        ticket = {"code": code, "poll": poll}

        # 승인 전에는 아무것도 안 준다
        assert c.post("/device/link/poll", json=ticket).status_code == 404
        # 이어지지 않은 기기는 승인하지 못한다
        assert c.post("/connector/approve", json={"code": code}).status_code == 401

        ok = c.post("/connector/approve", json={"code": code}, headers=head)
        assert ok.status_code == 200 and ok.json()["kind"] == "device"

        # 번호를 맞혀도 쪽지가 없으면 열쇠는 못 가져간다
        assert c.post("/device/link/poll", json={"code": code, "poll": "남의쪽지"}).status_code == 404

        got = c.post("/device/link/poll", json=ticket)
        assert got.status_code == 200 and got.json()["token"] != token
        # 열쇠는 한 번만 준다
        assert c.post("/device/link/poll", json=ticket).status_code == 404


def test_승인만_하고_안_가져가면_열쇠가_안_남는다(tmp_path, monkeypatch):
    """만들어 두고 아무도 안 가진 열쇠는 그 자체로 표를 더럽힌다."""
    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    with _client(app) as c:
        head = {"authorization": f"Bearer {_link(c)['token']}"}
        ticket = c.post("/device/link", json={}).json()
        code = ticket["code"]
        assert c.post("/connector/approve", json={"code": code}, headers=head).status_code == 200
        assert store.count_device_tokens() == 1

        c.post("/device/link/poll", json={"code": code, "poll": ticket["poll"]})
        assert store.count_device_tokens() == 2


def test_앱을_다시_깔면_복구_번호로_잇는다(tmp_path, monkeypatch):
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        first = _link(c)
        recovery = first["recovery"]

        # 앱을 지웠다 깔았다 — 폰에는 열쇠가 없고, 승인해 줄 기기도 없다
        assert c.post("/device/link", json={}).status_code == 202

        # 사람이 옮겨 적은 값이라 소문자·빈칸도 받아 준다
        typed = recovery.replace("-", " ").lower()
        again = c.post("/device/recover", json={"recovery": typed})
        assert again.status_code == 200
        assert again.json()["token"] != first["token"]
        # 한 번 쓰면 새 번호로 바뀐다
        assert again.json()["recovery"] != recovery
        assert c.post("/device/recover", json={"recovery": recovery}).status_code == 400


def test_틀린_복구_번호는_늦게_대답한다(tmp_path, monkeypatch):
    """잠그지는 않는다 — 잠금은 남이 대신 걸어서 주인을 막을 수 있다."""
    import nsr_server.app as app_module

    app, _ = _app(tmp_path, monkeypatch)
    waited: list[float] = []

    async def note(seconds: float) -> None:
        waited.append(seconds)

    monkeypatch.setattr(app_module.asyncio, "sleep", note)
    with _client(app) as c:
        good = _link(c)["recovery"]
        for _ in range(6):
            assert c.post("/device/recover", json={"recovery": "2222-3333-4444"}).status_code == 400
        assert waited == [app_module.BAD_RECOVERY_DELAY] * 6

        # 여러 번 틀린 뒤에도 맞는 번호는 그대로 열린다
        assert c.post("/device/recover", json={"recovery": good}).status_code == 200


def test_승인은_두_번_눌러도_된다(tmp_path, monkeypatch):
    """새 폰이 3초마다 묻는 중이라 '됐나?' 하고 또 누르는 일이 흔하다."""
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        head = {"authorization": f"Bearer {_link(c)['token']}"}
        ticket = c.post("/device/link", json={}).json()
        code = ticket["code"]
        assert c.post("/connector/approve", json={"code": code}, headers=head).status_code == 200
        assert c.post("/connector/approve", json={"code": code}, headers=head).status_code == 200
        got = c.post("/device/link/poll", json={"code": code, "poll": ticket["poll"]})
        assert got.status_code == 200 and got.json()["token"]


def test_번호_수명은_두드린다고_늘지_않는다(tmp_path, monkeypatch):
    """늘어나면 남이 열 자리를 잡고 두드리는 것만으로 잇기를 영영 막을 수 있다."""
    from nsr_server.link import LIVE_LINKS, new_link_code, poll_link

    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    ticket = new_link_code(store)
    before = store.take_oauth_pending(f"link-{ticket['code']}")
    store.put_oauth_pending(f"link-{ticket['code']}", before, expires_at=before["exp"])

    poll_link(store, ticket["code"], ticket["poll"])
    after = store.take_oauth_pending(f"link-{ticket['code']}")
    assert after["exp"] == before["exp"]

    # 자리는 유한하다. 다 차면 새 번호를 안 만든다
    store.put_oauth_pending(f"link-{ticket['code']}", after, expires_at=after["exp"])
    for _ in range(LIVE_LINKS - 1):
        new_link_code(store)
    with pytest.raises(RuntimeError):
        new_link_code(store)


def test_번호는_십분_뒤_죽는다(tmp_path, monkeypatch):
    from nsr_server.link import approve_link, new_link_code, poll_link

    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    ticket = new_link_code(store)
    holder = store.take_oauth_pending(f"link-{ticket['code']}")
    # 십분 하고 일 초가 지난 것으로 해 둔다
    store.put_oauth_pending(f"link-{ticket['code']}", holder, expires_at=holder["exp"] - 601)
    assert approve_link(store, ticket["code"]) is False
    assert poll_link(store, ticket["code"], ticket["poll"]) is None


def test_이어진_기기만_목록과_복구_번호를_본다(tmp_path, monkeypatch):
    app, _ = _app(tmp_path, monkeypatch)
    with _client(app) as c:
        out = _link(c)
        head = {"authorization": f"Bearer {out['token']}"}
        assert c.get("/device/state").status_code == 401

        state = c.get("/device/state", headers=head).json()
        assert state["recovery"] == out["recovery"]
        assert len(state["devices"]) == 1
        assert all("token" not in d for d in state["devices"])
        # 어느 줄이 내 폰인지 보여야 낯선 줄을 가릴 수 있다
        assert state["devices"][0]["mine"] is True


def test_다른_기기_끊기는_이_기기만_남긴다(tmp_path, monkeypatch):
    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    with _client(app) as c:
        out = _link(c)
        head = {"authorization": f"Bearer {out['token']}"}
        store.put_device_token("죽은열쇠1", "(앱)", "옛날 폰")
        store.put_device_token("죽은열쇠2", "(앱)", "더 옛날 폰")

        got = c.post("/device/forget-others", headers=head)
        assert got.status_code == 200 and got.json()["removed"] == 2
        assert store.count_device_tokens() == 1

        # nsr.env 의 비상 토큰으로는 못 한다 — 그러면 쓰던 폰까지 끊긴다
        env = {"authorization": f"Bearer {app.state.config.device_token}"}
        assert c.post("/device/forget-others", headers=env).status_code == 401
        assert store.count_device_tokens() == 1


def test_AI_연결은_이어진_폰만_승인한다(tmp_path, monkeypatch):
    """열쇠를 묻는 화면이 없어졌다. 여는 것은 폰이다."""
    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    with _client(app) as c:
        token = _link(c)["token"]

        # 커넥터가 사람을 보내는 자리 — 대기표와 번호를 만든다
        pending, number = "p-1", app.state.auth.new_code("p-1")
        store.put_oauth_pending(
            pending,
            {
                "client_id": "c1",
                "redirect_uri": "https://claude.ai/cb",
                "redirect_uri_provided_explicitly": True,
                "code_challenge": "chal",
                "state": "xyz",
                "scopes": [],
            },
            expires_at=__import__("time").time() + 600,
        )

        # 화면은 번호를 보여 주고 기다린다
        screen = c.get(f"/oauth/login?p={pending}&c={number}")
        assert screen.status_code == 200 and number[:3] in screen.text
        assert c.get(f"/oauth/login/status?p={pending}").json() == {}

        # 이어지지 않은 폰은 승인하지 못한다
        assert c.post("/connector/approve", json={"code": number}).status_code == 401
        head = {"authorization": f"Bearer {token}"}
        assert c.post("/connector/approve", json={"code": "000000"}, headers=head).status_code == 400

        # 이어진 폰이 승인하면 화면이 돌아갈 주소를 받아 간다
        ok = c.post("/connector/approve", json={"code": number}, headers=head)
        assert ok.status_code == 200 and ok.json()["kind"] == "ai"
        back = c.get(f"/oauth/login/status?p={pending}").json()["back"]
        assert back.startswith("https://claude.ai/cb?code=")
        # 주소는 한 번만 준다
        assert c.get(f"/oauth/login/status?p={pending}").json() == {}


def test_기기_번호와_AI_번호는_겹치지_않는다(tmp_path, monkeypatch):
    """같은 번호가 두 뜻을 가지면, 사람이 넣은 번호가 엉뚱한 쪽을 열 수 있다."""
    import secrets

    from nsr_server import link as link_module

    app, _ = _app(tmp_path, monkeypatch)
    store = app.state.store
    # 주사위가 늘 같은 눈만 나오게 해서 겹침을 강제로 만든다
    monkeypatch.setattr(secrets, "randbelow", lambda _n: 234567 - 100000)
    mine = link_module.new_link_code(store)["code"]
    assert mine == "234567"
    with pytest.raises(RuntimeError):
        app.state.auth.new_code("p-x")
    with pytest.raises(RuntimeError):
        link_module.new_link_code(store)


def test_기기_열쇠_목록에_열쇠는_없다(tmp_path):
    """구글 절을 지우면서 같이 없앴는데, 지금도 도는 동작이라 되살린다."""
    store = Store(str(tmp_path / "d.db"))
    store.put_device_token("tok-1", "(qr)", "폰")
    assert store.device_token_ok("tok-1")
    assert not store.device_token_ok("남의-열쇠")
    rows = store.list_device_tokens()
    assert len(rows) == 1 and rows[0]["label"] == "폰"
    assert "tok-1" not in str(rows)


def test_시간이_지난_번호는_안_열린다(tmp_path):
    import time as t

    from nsr_server.oauth import NsrOAuthProvider

    store = Store(str(tmp_path / "e.db"))
    provider = NsrOAuthProvider(store, "nsr.example.com")
    code = provider.new_code("p-old")
    # 대기표를 만료시킨다 (10분 뒤와 같은 상태)
    store.put_oauth_pending(f"code-{code}", {"p": "p-old"}, expires_at=t.time() - 1)
    assert provider.approve_from_phone(code) is False


def test_번호는_스무_개까지만_살아_있다(tmp_path):
    """아무나 /authorize 를 두드려 번호 공간을 채우면 남의 대기표에 승인이 떨어진다."""
    import pytest

    from nsr_server.oauth import LIVE_CODES, NsrOAuthProvider

    store = Store(str(tmp_path / "f.db"))
    provider = NsrOAuthProvider(store, "nsr.example.com")
    for i in range(LIVE_CODES):
        provider.new_code(f"p-{i}")
    with pytest.raises(RuntimeError):
        provider.new_code("p-넘침")


# ── 2차 검문소가 1차보다 느슨하면 안 된다 ────────────────
#
# 폰의 deidentify 가 잡는 모양을 서버가 못 잡으면, 검문소가 아니라 장식이다.
# 아래는 전부 실제로 그냥 지나가던 것들이다.


def test_점으로_쓴_전화번호도_잡는다():
    assert screen_text("연락처 010.1234.5678") == {"phone": 1}


def test_일반전화도_잡는다():
    assert screen_text("병동 02-123-4567 로 연락 주세요") == {"phone": 1}


def test_낱말이_붙은_등록번호는_다섯자리부터_잡는다():
    assert screen_text("환자 등록번호는 1234567 입니다") == {"mrn_labeled": 1}


def test_별표로_가린_주민번호도_잡는다():
    # 뒷자리를 가려도 생년월일과 성별은 남는다.
    assert screen_text("940101-2******") == {"rrn": 1}


def test_가려진_문장은_여전히_통과한다():
    assert screen_text("[이름]님 폴리 확인했어요. [등록번호] 맞아요. [전화번호]") == {}
