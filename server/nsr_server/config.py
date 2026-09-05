"""
설정. 전부 환경변수로 받는다 — 저장소에 값이 들어가면 안 된다.

  NSR_MCP_TOKEN     대화 AI(클로드·GPT) 가 붙을 때 쓰는 토큰. 주소에 들어간다.
  NSR_DEVICE_TOKEN  폰이 자료를 올릴 때 쓰는 토큰. 헤더에 들어간다.
  NSR_DB            SQLite 파일 경로 (기본 ./nsr.db)
  NSR_HOST/NSR_PORT 붙일 주소 (기본 127.0.0.1:8787 — 바깥은 nginx·caddy 가 받는다)
  NSR_PUBLIC_HOST   바깥에서 부르는 도메인 (예: nsr.example.com). **없으면 붙지 않는다.**
  NSR_ALLOWED_ORIGINS  커넥터의 Origin 목록. 쉼표로 나눈다. 비우면 기본값을 쓴다.

두 토큰을 나눠 둔 이유: 하나가 새면 그 하나만 갈면 된다. 폰 토큰이 새도 남이
전사본을 읽지는 못하고, MCP 토큰이 새도 남이 자료를 올리지는 못한다.
"""

from __future__ import annotations

import os
import secrets


def _need(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(
            f"환경변수 {name} 이 비어 있습니다. 아래처럼 만들어 넣으십시오:\n"
            f"  {name}={secrets.token_urlsafe(32)}"
        )
    if len(value) < 32:
        raise SystemExit(f"환경변수 {name} 이 너무 짧습니다. 32자 이상으로 만드십시오.")
    return value


# 커넥터가 보내는 Origin. 여기 없는 곳에서 오면 403 이 난다 — 그때는
# journalctl -u nsr 에 "Invalid Origin header: ..." 가 찍히니 그 값을
# NSR_ALLOWED_ORIGINS 에 더한다.
DEFAULT_ORIGINS = (
    "https://claude.ai",
    "https://www.claude.ai",
    "https://chatgpt.com",
    "https://chat.openai.com",
)


class Config:
    def __init__(self) -> None:
        self.mcp_token = _need("NSR_MCP_TOKEN")
        self.device_token = _need("NSR_DEVICE_TOKEN")
        self.db_path = os.environ.get("NSR_DB", "nsr.db")
        self.host = os.environ.get("NSR_HOST", "127.0.0.1")
        self.port = int(os.environ.get("NSR_PORT", "8787"))
        if self.mcp_token == self.device_token:
            raise SystemExit("두 토큰은 서로 달라야 합니다.")

        # 프록시(nginx·caddy) 뒤에서는 이것이 없으면 MCP 가 421 로 막힌다.
        # MCP SDK 가 "127.0.0.1 에 붙었으니 로컬 서버겠지" 하고 DNS 리바인딩
        # 보호를 자동으로 켜서, 프록시가 넘긴 진짜 도메인 Host 를 거부하기 때문이다.
        # 그래서 바깥 도메인을 여기서 알려 준다. `*` 를 넣으면 보호를 끈다.
        self.public_host = os.environ.get("NSR_PUBLIC_HOST", "").strip()
        origins = os.environ.get("NSR_ALLOWED_ORIGINS", "").strip()
        self.allowed_origins = [o.strip() for o in origins.split(",") if o.strip()] or list(
            DEFAULT_ORIGINS
        )
