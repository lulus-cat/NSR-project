"""
폰 잇기 — 앱과 서버 둘만으로. 터미널도, 붙여넣기도 없다.

왜 이 길인가
-----------
전에는 VPS 에서 `python -m nsr_server.pair` 를 돌려 QR 을 만들었다. 안전하긴 한데
잇기를 하려면 매번 서버에 들어가야 했다 — 비개발자에게는 그게 벽이다.

큰 회사들이 자기 서버를 직접 돌리는 제품(Jellyfin·Home Assistant·Immich·Syncthing)
에서 쓰는 방식을 그대로 따른다.

  1. **처음 한 번만 열리는 문** — 이어진 기기가 하나도 없으면 첫 요청이 그냥
     이어진다. 붙는 순간 문은 닫힌다.
  2. **이미 이은 기기가 다음 기기를 승인** — 두 번째 폰부터는 여섯 자리 번호를
     띄우고, 이미 이어진 폰에서 승인해야 열쇠가 나온다.
  3. **복구 번호** — 앱을 지웠다 다시 깔면 폰의 열쇠가 사라진다. 그때 승인해 줄
     기기도 없으면 잇는 길이 막힌다. 그래서 처음 이을 때 복구 번호를 하나 만들고,
     이어진 앱은 언제든 그 번호를 볼 수 있다. 한 번 쓰면 새 번호로 바뀐다.

문이 열려 있는 동안의 위험은 "먼저 붙는 쪽이 이긴다" 하나다. 도메인은 인증서
기록으로 공개되므로 아주 없지는 않다. 그래서 앱이 '이어진 기기' 목록을 보여 주고
(낯선 기기가 있으면 눈에 띈다), 최후에는 nsr.env 의 고정 토큰이 남아 있다.
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from .store import Store

LINK_TTL = 60 * 10  # 새 기기가 번호를 띄워 놓고 기다리는 시간
LIVE_LINKS = 10  # 동시에 살아 있을 수 있는 기기 번호
RECOVERY_KEY = "recovery"
# 헷갈리는 글자(0·O·1·I)를 뺀 32글자. 12자면 대충 60비트다.
ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
FAIL_MAX = 5  # 복구 번호를 이만큼 틀리면
FAIL_LOCK = 60 * 10  # 이만큼 잠근다


def _new_recovery() -> str:
    raw = "".join(secrets.choice(ALPHABET) for _ in range(12))
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def clean_recovery(raw: str) -> str:
    """사람이 넣는 값이다 — 소문자·빈칸·다른 줄표를 모두 받아 준다."""
    only = "".join(c for c in (raw or "").upper() if c in ALPHABET)
    return f"{only[:4]}-{only[4:8]}-{only[8:12]}" if len(only) == 12 else ""


def recovery_code(store: Store) -> str:
    """지금 번호. 없으면 만든다."""
    code = store.get_meta(RECOVERY_KEY)
    if not code:
        code = _new_recovery()
        store.put_meta(RECOVERY_KEY, code)
    return code


def issue_token(store: Store, label: str) -> dict[str, str]:
    """열쇠를 발급한다. 복구 번호도 함께 준다 — 앱이 화면에 띄워 적어 두게 한다."""
    token = secrets.token_urlsafe(32)
    store.put_device_token(token, "(앱)", label)
    return {"token": token, "recovery": recovery_code(store)}


def use_recovery(store: Store, given: str) -> dict[str, str] | None:
    """복구 번호를 열쇠로 바꾼다. 맞으면 번호는 새것으로 바뀐다(한 번만 쓴다)."""
    want = store.get_meta(RECOVERY_KEY)
    given = clean_recovery(given)
    if not want or not given:
        return None
    if not secrets.compare_digest(given, want):
        return None
    store.put_meta(RECOVERY_KEY, _new_recovery())
    return issue_token(store, "복구 번호로 이은 기기")


# ── 여섯 자리 기기 번호 ───────────────────────────────────
#
# AI 커넥터 번호(`code-`)와 같은 서랍(oauth_pending)에 살지만 앞글자가 다르다.
# 만들 때 양쪽을 다 확인해서 같은 번호가 두 뜻을 갖는 일이 없게 한다 — 하나만
# 보고 만들면 사용자가 앱에 넣은 번호가 엉뚱한 쪽을 열어 줄 수 있다.


def new_link_code(store: Store) -> str:
    if store.count_oauth_pending("link-") >= LIVE_LINKS:
        raise RuntimeError("잇기 시도가 너무 많습니다. 10분 뒤에 다시 해 주십시오.")
    for _ in range(20):
        code = f"{secrets.randbelow(900000) + 100000}"
        if store.peek_oauth_pending(f"link-{code}") or store.peek_oauth_pending(f"code-{code}"):
            continue
        store.put_oauth_pending(
            f"link-{code}", {"state": "wait"}, expires_at=time.time() + LINK_TTL
        )
        return code
    raise RuntimeError("번호를 만들지 못했습니다. 잠시 뒤 다시 해 주십시오.")


def approve_link(store: Store, code: str) -> bool:
    """
    이미 이어진 폰이 새 기기를 승인한다.

    여기서 열쇠를 만들지 않는다 — 새 기기가 주우러 올 때 만든다. 승인만 하고
    안 주워 가면 아무도 안 가진 열쇠가 표에 남고, 그 한 줄 때문에 '기기가 0대'
    라는 조건이 깨져 처음 열리는 문이 영영 닫힌다.
    """
    holder = store.take_oauth_pending(f"link-{code.strip()}")
    if not holder or holder.get("state") != "wait":
        return False
    store.put_oauth_pending(
        f"link-{code.strip()}", {"state": "ok"}, expires_at=time.time() + LINK_TTL
    )
    return True


def poll_link(store: Store, code: str) -> dict[str, Any] | None:
    """
    새 기기가 몇 초마다 들여다본다. 승인 전이면 None, 승인 뒤에는 **한 번만** 열쇠.

    (Nextcloud 의 Login Flow v2 와 같은 모양이다. 200 은 한 번뿐이다.)
    """
    key = f"link-{code.strip()}"
    holder = store.take_oauth_pending(key)
    if not holder:
        return None
    if holder.get("state") != "ok":
        # 아직 기다리는 중이다. 꺼냈으니 도로 넣어 둔다.
        store.put_oauth_pending(key, holder, expires_at=time.time() + LINK_TTL)
        return None
    return issue_token(store, "승인받은 기기")


class FailLock:
    """
    복구 번호를 찍어 보는 것을 막는다.

    ponytail: 프로세스 안에만 둔다 — 서버를 껐다 켜면 풀린다. 번호가 12자리라
    잠금이 없어도 찍기는 사실상 불가능하고, 이건 실수로 여러 번 넣었을 때를 위한
    안전장치다. DB 로 옮길 이유가 생기면 그때 옮긴다.
    """

    def __init__(self) -> None:
        self.fails = 0
        self.until = 0.0

    def locked(self) -> bool:
        return time.time() < self.until

    def bad(self) -> None:
        self.fails += 1
        if self.fails >= FAIL_MAX:
            self.fails = 0
            self.until = time.time() + FAIL_LOCK

    def good(self) -> None:
        self.fails = 0
