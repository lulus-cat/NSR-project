"""
설정. 전부 환경변수로 받는다 — 저장소에 값이 들어가면 안 된다.

  NSR_MCP_TOKEN     대화 AI(클로드·GPT) 가 붙을 때 쓰는 토큰. 주소에 들어간다.
  NSR_DEVICE_TOKEN  폰이 자료를 올릴 때 쓰는 토큰. 헤더에 들어간다.
  NSR_DB            SQLite 파일 경로 (기본 ./nsr.db)
  NSR_HOST/NSR_PORT 붙일 주소 (기본 127.0.0.1:8787 — 바깥은 caddy 가 받는다)

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
    if len(value) < 24:
        raise SystemExit(f"환경변수 {name} 이 너무 짧습니다. 32자 이상으로 만드십시오.")
    return value


class Config:
    def __init__(self) -> None:
        self.mcp_token = _need("NSR_MCP_TOKEN")
        self.device_token = _need("NSR_DEVICE_TOKEN")
        self.db_path = os.environ.get("NSR_DB", "nsr.db")
        self.host = os.environ.get("NSR_HOST", "127.0.0.1")
        self.port = int(os.environ.get("NSR_PORT", "8787"))
        if self.mcp_token == self.device_token:
            raise SystemExit("두 토큰은 서로 달라야 합니다.")
