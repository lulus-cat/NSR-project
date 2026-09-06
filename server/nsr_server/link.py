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
# 복구 번호를 틀렸을 때 대답을 늦추는 시간.
#
# 잠그지 않는 이유: 잠금은 **남이 대신 걸 수 있다.** 인증 없이 아무 값이나
# 몇 번 넣어 두면 정작 주인이 못 들어온다. 번호가 32^12(대략 60비트)라 초에
# 한 번꼴로 늦추기만 해도 찍기는 사람 수명 밖으로 나간다.
BAD_RECOVERY_DELAY = 1.0


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


def first_token(store: Store, label: str) -> dict[str, str] | None:
    """
    문이 열려 있을 때의 첫 열쇠. **기기가 0대일 때만** 만들어진다.

    세기와 넣기를 store 안에서 한 몸으로 처리한다 — 여기서 나눠 하면 워커가
    둘 이상일 때 두 대가 동시에 첫 기기가 된다.
    """
    token = secrets.token_urlsafe(32)
    if not store.claim_first_device(token, label):
        return None
    return {"token": token, "recovery": recovery_code(store)}


def use_recovery(store: Store, given: str) -> dict[str, str] | None:
    """
    복구 번호를 열쇠로 바꾼다. 맞으면 번호는 새것으로 바뀐다(한 번만 쓴다).

    모양이 틀린 것(오타)과 값이 틀린 것(찍기)을 가른다 — 앱을 다시 깔고 열두
    글자를 손으로 옮겨 적는 사람에게 오타는 기본값이다. 그걸 찍기와 같이 세면
    정작 맞게 넣을 때 서버가 늦어져 있다.
    """
    want = store.get_meta(RECOVERY_KEY)
    given = clean_recovery(given)
    if not given:
        return None
    if not want or not secrets.compare_digest(given, want):
        return None
    store.put_meta(RECOVERY_KEY, _new_recovery())
    return issue_token(store, "복구 번호로 이은 기기")


# ── 여섯 자리 기기 번호 ───────────────────────────────────
#
# AI 커넥터 번호(`code-`)와 같은 서랍(oauth_pending)에 살지만 앞글자가 다르다.
# 만들 때 양쪽을 다 확인해서 같은 번호가 두 뜻을 갖는 일이 없게 한다 — 하나만
# 보고 만들면 사용자가 앱에 넣은 번호가 엉뚱한 쪽을 열어 줄 수 있다.


def new_link_code(store: Store) -> dict[str, str]:
    """
    번호와, 그 번호를 들여다볼 수 있는 **쪽지**를 함께 만든다.

    쪽지를 따로 두는 이유: 여섯 자리는 사람이 옮겨 적으라고 짧게 만든 값이라
    찍어 볼 수 있다. 폴링에 쪽지까지 요구하면, 번호를 맞혀도 열쇠는 못 가져간다
    (Nextcloud 의 Login Flow v2 가 화면 값과 폴링 값을 나누는 것과 같은 이유다).
    """
    if store.count_oauth_pending("link-") >= LIVE_LINKS:
        raise RuntimeError("지금은 새로 이을 수 없습니다. 10분 뒤에 다시 해 주십시오.")
    exp = time.time() + LINK_TTL
    poll = secrets.token_urlsafe(24)
    for _ in range(20):
        code = f"{secrets.randbelow(900000) + 100000}"
        if store.peek_oauth_pending(f"link-{code}") or store.peek_oauth_pending(f"code-{code}"):
            continue
        store.put_oauth_pending(
            f"link-{code}", {"state": "wait", "poll": poll, "exp": exp}, expires_at=exp
        )
        return {"code": code, "poll": poll}
    raise RuntimeError("번호를 만들지 못했습니다. 잠시 뒤 다시 해 주십시오.")


def approve_link(store: Store, code: str) -> bool:
    """
    이미 이어진 폰이 새 기기를 승인한다.

    여기서 열쇠를 만들지 않는다 — 새 기기가 주우러 올 때 만든다. 승인만 하고
    안 주워 가면 아무도 안 가진 열쇠가 표에 남고, 그 한 줄 때문에 '기기가 0대'
    라는 조건이 깨져 처음 열리는 문이 영영 닫힌다.

    두 번 눌러도 된다. 새 폰이 3초마다 묻고 있으니 "됐나?" 하고 한 번 더 넣는
    것은 아주 흔한 일인데, 그때 대기표를 없애 버리면 잇기가 조용히 죽는다.
    """
    key = f"link-{code.strip()}"
    holder = store.take_oauth_pending(key)
    if not holder:
        return False
    # 만료 시각은 처음 정한 것을 그대로 물려준다. 여기서 다시 밀면 번호가
    # 안 죽어서, 남이 열 개를 잡고 두드리는 것만으로 잇기를 영영 막을 수 있다.
    exp = float(holder.get("exp") or time.time() + LINK_TTL)
    store.put_oauth_pending(key, {**holder, "state": "ok"}, expires_at=exp)
    return True


def poll_link(store: Store, code: str, poll: str) -> dict[str, Any] | None:
    """
    새 기기가 몇 초마다 들여다본다. 승인 전이면 None, 승인 뒤에는 **한 번만** 열쇠.

    (Nextcloud 의 Login Flow v2 와 같은 모양이다. 200 은 한 번뿐이다.)
    """
    key = f"link-{code.strip()}"
    holder = store.take_oauth_pending(key)
    if not holder:
        return None
    exp = float(holder.get("exp") or time.time() + LINK_TTL)
    # bytes 로 견준다. compare_digest 는 ASCII 가 아닌 str 을 받으면 터지는데,
    # 여기 들어오는 값은 바깥에서 온 아무 글자나다 (한글을 넣으면 500 이 났다).
    mine = secrets.compare_digest(
        str(holder.get("poll", "")).encode("utf-8"), (poll or "").encode("utf-8")
    )
    if not mine or holder.get("state") != "ok":
        # 아직 기다리는 중이거나 남의 번호다. 꺼냈으니 도로 넣어 둔다.
        store.put_oauth_pending(key, holder, expires_at=exp)
        return None
    return issue_token(store, "승인받은 기기")
