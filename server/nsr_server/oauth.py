"""
OAuth — 대화 AI 커넥터가 요구하는 로그인 절차.

왜 필요한가
----------
처음에는 추측 불가능한 토큰을 주소에 넣어 두는 것으로 충분하다고 봤다. 그런데
클로드 커넥터는 주소를 넣으면 **먼저 OAuth 등록을 시도하고**, 등록할 곳이 없으면
"로그인 서비스에 등록할 수 없습니다"로 멈춘다. 인증 없는 서버로 넘어가 주지 않는다.

그래서 OAuth 를 붙인다. 덤으로 더 안전해진다 — 주소가 더 이상 열쇠가 아니다.
주소는 공개돼도 되고, **열쇠는 로그인 화면에서 한 번 입력**한다. 화면 공유나
캡처로 새는 길이 사라진다.

한 사람이 쓰는 서버라 사용자 계정은 없다. 로그인 화면이 묻는 것은 하나다 —
`NSR_MCP_TOKEN` 을 아는가. 그것이 이 서버의 비밀번호다.

절차 (SDK 가 대부분 처리한다)
---------------------------
  1. 커넥터가 /register 로 자기를 등록한다 (누구든 등록은 된다. 열쇠가 없으면
     다음 단계를 못 넘는다)
  2. 사람이 /authorize 로 온다 → 우리 로그인 화면 → 열쇠 확인 → 코드 발급
  3. 커넥터가 /token 으로 코드를 바꿔 간다 (PKCE 검사는 SDK 가 한다)
  4. 그 뒤 모든 MCP 요청에 그 토큰이 붙는다

토큰과 코드는 SQLite 에 남는다. 서버를 재시작해도 다시 로그인하지 않아도 된다.
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    RefreshToken,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from .store import Store

# 토큰 수명. 만료돼도 커넥터가 refresh 로 조용히 갱신한다.
ACCESS_TTL = 60 * 60 * 24 * 30  # 30일
CODE_TTL = 60 * 5  # 5분
PENDING_TTL = 60 * 10  # 로그인 화면을 열어 둔 채 자리를 비울 수 있는 시간


class NsrOAuthProvider:
    """한 사람만 쓰는 서버의 인증 담당. 아는 열쇠가 곧 신분이다."""

    def __init__(self, store: Store, mcp_token: str, public_host: str) -> None:
        self.store = store
        self.mcp_token = mcp_token
        self.public_host = public_host

    # ── 커넥터 등록 ───────────────────────────────────────

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        row = self.store.get_oauth_client(client_id)
        return OAuthClientInformationFull.model_validate(row) if row else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        # 등록 자체는 막지 않는다. 열쇠를 모르면 아래 로그인에서 걸린다.
        self.store.put_oauth_client(client_info.client_id, client_info.model_dump(mode="json"))

    # ── 로그인 ────────────────────────────────────────────

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        """
        사람을 우리 로그인 화면으로 보낸다.

        여기서 바로 코드를 내주지 않는다. 그러면 주소를 아는 것만으로 연결이 되고,
        그건 예전의 '주소가 곧 열쇠' 로 돌아가는 것이다.
        """
        pending = secrets.token_urlsafe(24)
        self.store.put_oauth_pending(
            pending,
            {
                "client_id": client.client_id,
                "redirect_uri": str(params.redirect_uri),
                "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
                "code_challenge": params.code_challenge,
                "state": params.state,
                "scopes": params.scopes or [],
                "resource": params.resource,
            },
            expires_at=time.time() + PENDING_TTL,
        )
        return f"https://{self.public_host}/oauth/login?p={pending}"

    def approve(self, pending_id: str, key: str) -> str | None:
        """
        로그인 화면이 부른다. 열쇠가 맞으면 코드를 만들어 돌아갈 주소를 준다.
        틀리면 None — 화면은 "열쇠가 맞지 않아요" 라고만 적는다.
        """
        pending = self.store.take_oauth_pending(pending_id)
        if not pending:
            return None
        # 길이가 달라도 같은 시간이 걸리게 비교한다. **바이트로 비교한다** —
        # compare_digest 는 아스키가 아닌 글자가 든 문자열을 받으면 TypeError 를
        # 던진다. 한글을 넣어 본 사람이 서버를 500 으로 넘어뜨릴 수 있었다.
        if not secrets.compare_digest(key.strip().encode("utf-8"), self.mcp_token.encode("utf-8")):
            # 열쇠가 틀렸으면 대기표를 되살려 다시 시도할 수 있게 둔다.
            self.store.put_oauth_pending(pending_id, pending, expires_at=time.time() + PENDING_TTL)
            return None

        code = secrets.token_urlsafe(32)
        self.store.put_oauth_code(
            code,
            {
                "code": code,
                "client_id": pending["client_id"],
                "redirect_uri": pending["redirect_uri"],
                "redirect_uri_provided_explicitly": pending["redirect_uri_provided_explicitly"],
                "code_challenge": pending["code_challenge"],
                "scopes": pending["scopes"],
                "resource": pending.get("resource"),
                "expires_at": time.time() + CODE_TTL,
            },
        )
        sep = "&" if "?" in pending["redirect_uri"] else "?"
        back = f"{pending['redirect_uri']}{sep}code={code}"
        if pending.get("state"):
            back += f"&state={pending['state']}"
        return back

    # ── 코드를 토큰으로 ───────────────────────────────────

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        row = self.store.get_oauth_code(authorization_code)
        if not row or row["client_id"] != client.client_id:
            return None
        if row["expires_at"] < time.time():
            self.store.delete_oauth_code(authorization_code)
            return None
        return AuthorizationCode.model_validate(row)

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        # 코드는 한 번만 쓴다.
        self.store.delete_oauth_code(authorization_code.code)
        return self._issue(client.client_id, authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        row = self.store.get_oauth_token(refresh_token, kind="refresh")
        if not row or row["client_id"] != client.client_id:
            return None
        return RefreshToken(token=row["token"], client_id=row["client_id"], scopes=row["scopes"])

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        self.store.delete_oauth_token(refresh_token.token)
        return self._issue(client.client_id, scopes or refresh_token.scopes, None)

    # ── 토큰 확인 (모든 MCP 요청) ─────────────────────────

    async def load_access_token(self, token: str) -> AccessToken | None:
        row = self.store.get_oauth_token(token, kind="access")
        if not row:
            return None
        if row["expires_at"] and row["expires_at"] < time.time():
            self.store.delete_oauth_token(token)
            return None
        return AccessToken(
            token=row["token"],
            client_id=row["client_id"],
            scopes=row["scopes"],
            expires_at=int(row["expires_at"]) if row["expires_at"] else None,
            resource=row.get("resource"),
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        return await self.load_access_token(token)

    async def revoke_token(self, token: Any) -> None:
        self.store.delete_oauth_token(getattr(token, "token", str(token)))

    # ── 안쪽 ─────────────────────────────────────────────

    def _issue(self, client_id: str, scopes: list[str], resource: str | None) -> OAuthToken:
        access = secrets.token_urlsafe(32)
        refresh = secrets.token_urlsafe(32)
        now = time.time()
        self.store.put_oauth_token(access, "access", client_id, scopes, now + ACCESS_TTL, resource)
        self.store.put_oauth_token(refresh, "refresh", client_id, scopes, None, resource)
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TTL,
            scope=" ".join(scopes) if scopes else None,
            refresh_token=refresh,
        )
