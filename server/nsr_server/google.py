"""
구글 로그인 — 열쇠를 사람이 외우거나 붙여넣지 않게 한다.

왜 서버가 하나
-------------
안드로이드 앱이 직접 구글에 로그인하려면 구글 콘솔에 **앱 패키지 이름과 서명
지문(SHA-1)** 을 등록해야 한다. 이 앱은 CI 가 서명하므로 서명 키가 바뀌면
로그인이 조용히 깨진다. 그래서 로그인은 서버가 한다 — 구글 콘솔에는 '웹
애플리케이션' 클라이언트 하나만 만들고, 폰은 브라우저를 열었다가 결과만 받는다.
폰에는 구글 비밀값이 하나도 없다.

받는 것은 이메일 하나
--------------------
scope 는 `openid email` 뿐이다. 이건 구글이 '민감하지 않은 권한'으로 분류해서
심사(verification)를 받지 않아도 되고, 경고 화면도 안 뜬다. 드라이브 같은 것을
붙일 생각이 없으면 이 상태를 유지하는 편이 낫다.

서명 검증을 왜 안 하나
--------------------
id_token 을 구글의 토큰 창구에서 **HTTPS 로 직접** 받아 오기 때문이다. 중간에
낄 수 있는 사람이 없으므로 서명을 다시 확인할 필요가 없다고 구글 문서가
명시한다. 대신 aud·iss·exp·email_verified 는 여기서 직접 본다 — 이건 값이
틀렸을 때 우리를 지켜 주는 검사라 생략하지 않는다.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
from typing import Any
from urllib.request import Request, urlopen

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
ISSUERS = ("accounts.google.com", "https://accounts.google.com")


class GoogleError(Exception):
    pass


def auth_url(client_id: str, redirect_uri: str, state: str) -> str:
    """사람을 보낼 구글 로그인 주소."""
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email",
            "state": state,
            # 계정이 여러 개인 폰에서 엉뚱한 계정으로 붙는 것을 막는다.
            "prompt": "select_account",
            "access_type": "online",
        }
    )
    return f"{AUTH_URL}?{query}"


def claims_of(id_token: str) -> dict[str, Any]:
    """id_token 가운데 토막(payload)을 푼다. 서명은 위 설명대로 보지 않는다."""
    try:
        part = id_token.split(".")[1]
        part += "=" * (-len(part) % 4)  # base64url 은 꼬리 = 를 뗀다
        return json.loads(base64.urlsafe_b64decode(part))
    except Exception as e:
        raise GoogleError("구글이 준 표를 읽지 못했습니다.") from e


def check(claims: dict[str, Any], client_id: str, now: float | None = None) -> str:
    """표가 우리 것이고 살아 있는지 본다. 맞으면 이메일을, 아니면 예외를."""
    now = time.time() if now is None else now
    if claims.get("aud") != client_id:
        raise GoogleError("다른 앱에서 만든 표입니다.")
    if claims.get("iss") not in ISSUERS:
        raise GoogleError("구글이 만든 표가 아닙니다.")
    if float(claims.get("exp") or 0) < now:
        raise GoogleError("표가 만료됐습니다. 다시 로그인해 주십시오.")
    if not claims.get("email_verified"):
        raise GoogleError("이메일이 확인되지 않은 계정입니다.")
    email = str(claims.get("email") or "").strip().lower()
    if not email:
        raise GoogleError("구글이 이메일을 주지 않았습니다.")
    return email


def email_of(code: str, client_id: str, client_secret: str, redirect_uri: str) -> str:
    """구글이 준 코드를 이메일로 바꾼다."""
    data = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
    ).encode("utf-8")
    req = Request(TOKEN_URL, data=data, method="POST")
    req.add_header("content-type", "application/x-www-form-urlencoded")
    try:
        with urlopen(req, timeout=20) as res:  # noqa: S310 - 주소가 고정이다
            body = json.loads(res.read())
    except GoogleError:
        raise
    except Exception as e:
        # 구글 응답 본문에는 client_secret 이 되돌아오지 않지만, 그래도 안 옮긴다.
        raise GoogleError(f"구글과 이야기하지 못했습니다: {type(e).__name__}") from e

    id_token = body.get("id_token")
    if not id_token:
        raise GoogleError("구글이 신분 표를 주지 않았습니다.")
    return check(claims_of(id_token), client_id)
