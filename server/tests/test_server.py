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
