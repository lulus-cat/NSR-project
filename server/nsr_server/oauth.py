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

신분 확인은 **폰이 한다**
------------------------
로그인 화면은 열쇠를 묻지 않는다. 여섯 자리 번호를 보여 주고, 이미 이어진 폰에서
그 번호를 승인하면 열린다 (`POST /connector/approve`, 기기 열쇠 필요).

이렇게 한 이유: 열쇠를 묻는 화면은 결국 사람이 열쇠를 어딘가에 적어 두게 만든다.
번호는 10분이면 사라지고 그 자체로는 아무 힘이 없다 — 승인할 폰이 없으면 못 연다.
폰은 QR 로 잇는다(`python -m nsr_server.pair`). 그래서 이 서버로 들어오는 길은
둘 다 폰을 거친다.

절차 (SDK 가 대부분 처리한다)
---------------------------
  1. 커넥터가 /register 로 자기를 등록한다 (누구든 등록은 된다. 폰이 승인하지
     않으면 다음 단계를 못 넘는다)
  2. 사람이 /authorize 로 온다 → 번호 화면 → 폰이 승인 → 코드 발급
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
LIVE_CODES = 20  # 동시에 살아 있을 수 있는 연결 번호 (90만 자리 중 20개)


class NsrOAuthProvider:
    """한 사람만 쓰는 서버의 인증 담당. 폰이 승인해야 열린다."""

    def __init__(self, store: Store, public_host: str) -> None:
        self.store = store
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
        code = self.new_code(pending)
        return f"https://{self.public_host}/oauth/login?p={pending}&c={code}"

    def new_code(self, pending_id: str) -> str:
        """
        화면에 띄울 여섯 자리 번호. 폰이 이 번호로 대기표를 찾아 승인한다.

        번호가 짧아도 되는 이유: 승인하려면 이미 이어진 폰의 열쇠가 있어야 하고,
        번호는 10분 뒤 사라진다. 번호만 알아서는 아무것도 못 연다.
        """
        # 살아 있는 번호가 너무 많으면 만들지 않는다. 아무나 /authorize 를
        # 두드려 번호 공간을 채워 두면, 사용자가 한 자리를 잘못 눌러도 남의
        # 대기표에 떨어질 수 있다 — 그건 곧 남에게 문을 열어 주는 것이다.
        if self.store.count_oauth_pending("code-") >= LIVE_CODES:
            raise RuntimeError("연결 시도가 너무 많습니다. 10분 뒤에 다시 해 주십시오.")
        for _ in range(20):
            code = f"{secrets.randbelow(900000) + 100000}"
            if not self.store.peek_oauth_pending(f"code-{code}"):
                self.store.put_oauth_pending(
                    f"code-{code}", {"p": pending_id}, expires_at=time.time() + PENDING_TTL
                )
                return code
        raise RuntimeError("연결 번호를 만들지 못했습니다. 잠시 뒤 다시 해 주십시오.")

    def approve_from_phone(self, code: str) -> bool:
        """
        폰이 번호를 승인한다. 성공하면 화면이 주워 갈 자리에 돌아갈 주소를 둔다.

        커넥터 화면은 이 자리를 2초마다 들여다보다가(`/oauth/login/status`) 주소가
        생기면 그리로 간다. 폰과 화면이 서로 직접 이야기하지 않아도 되는 이유다.
        """
        holder = self.store.take_oauth_pending(f"code-{code.strip()}")
        if not holder:
            return False
        pending = self.store.take_oauth_pending(str(holder.get("p", "")))
        if not pending:
            return False
        self.store.put_oauth_pending(
            f"approved-{holder['p']}",
            {"back": self.grant(pending)},
            expires_at=time.time() + CODE_TTL,
        )
        return True

    def grant(self, pending: dict[str, Any]) -> str:
        """
        승인이 끝난 뒤 — 코드를 만들어 커넥터가 돌아갈 주소를 준다.

        부르는 곳은 하나다: 폰이 번호를 승인했을 때(`approve_from_phone`).
        """
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
