"""
설정. 전부 환경변수로 받는다 — 저장소에 값이 들어가면 안 된다.

  NSR_DEVICE_TOKEN  비상용 토큰. 평소에는 앱에서 「잇기」 를 누르면 이어진다
                    (link.py). 헤더에 들어간다.
  NSR_DB            SQLite 파일 경로 (기본 ./nsr.db)
  NSR_HOST/NSR_PORT 붙일 주소 (기본 127.0.0.1:8787 — 바깥은 nginx·caddy 가 받는다)
  NSR_PUBLIC_HOST   바깥에서 부르는 도메인 (예: nsr.example.com). **없으면 붙지 않는다.**
                    '*' 는 받지 않는다 — 보호가 꺼진다.
  NSR_ALLOWED_ORIGINS  커넥터의 Origin 목록. 쉼표로 나눈다. 비우면 기본값을 쓴다.
  NSR_TIRO_KEY      티로 API 열쇠. 있으면 서버가 티로에서 직접 노트를 가져온다.
  NSR_REPO          저장소 경로 (기본 ../ — 가리기 스크립트를 여기서 찾는다)
  NSR_OPEN_MINUTES  첫 기기를 받는 문이 열려 있는 시간(분). 기본 30.
                    서버가 켜진 뒤 이 시간 안에만 첫 폰이 그냥 이어진다.
                    지나면 `systemctl restart nsr` 로 다시 연다.
                    0 은 제한 없음. 음수면 문이 아예 안 열린다.

대화 AI(클로드·GPT) 쪽에는 토큰이 없다. 커넥터를 연결할 때 화면에 여섯 자리
번호가 뜨고, **이미 이어진 폰에서** 그 번호를 승인해야 열린다. 그래서 이 서버에
들어오는 길은 둘 다 폰을 거친다 — 폰은 앱에서 잇고, AI 는 폰이 승인한다.
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
        self.device_token = _need("NSR_DEVICE_TOKEN")
        self.db_path = os.environ.get("NSR_DB", "nsr.db")
        self.host = os.environ.get("NSR_HOST", "127.0.0.1")
        # 오타 하나에 스택 추적이 뜨지 않게. 이 파일의 다른 값들과 같은 대접이다.
        try:
            self.port = int(os.environ.get("NSR_PORT", "8787"))
        except ValueError:
            raise SystemExit("환경변수 NSR_PORT 는 숫자여야 합니다 (예: 8787).") from None
        # 프록시(nginx·caddy) 뒤에서는 이것이 없으면 MCP 가 421 로 막힌다.
        # MCP SDK 가 "127.0.0.1 에 붙었으니 로컬 서버겠지" 하고 DNS 리바인딩
        # 보호를 자동으로 켜서, 프록시가 넘긴 진짜 도메인 Host 를 거부하기 때문이다.
        # 그래서 바깥 도메인을 여기서 알려 준다. `*` 는 받지 않는다 —
        # 보호가 꺼지면 남의 브라우저가 이 서버를 대신 부를 수 있다.
        self.tiro_key = os.environ.get("NSR_TIRO_KEY", "").strip()
        self.repo_root = os.path.abspath(
            os.environ.get("NSR_REPO", os.path.join(os.path.dirname(__file__), "..", ".."))
        )
        self.public_host = os.environ.get("NSR_PUBLIC_HOST", "").strip()
        # 문을 언제까지 열어 둘까. 도메인은 인증서 기록(CT)으로 공개되므로,
        # 아무 때나 열려 있으면 도메인을 아는 쪽이 먼저 붙을 수 있다.
        # max(0, ...) 을 쓰지 않는다. 음수를 0 으로 접으면 0 이 '제한 없음' 이라
        # 오타 하나가 문을 영영 열어 둔다. 음수는 그대로 둬서 문이 닫히게 한다 —
        # 오타의 기본값은 가장 안전한 쪽이어야 한다.
        try:
            self.open_minutes = int(os.environ.get("NSR_OPEN_MINUTES", "30"))
        except ValueError:
            self.open_minutes = 30

        origins = os.environ.get("NSR_ALLOWED_ORIGINS", "").strip()
        self.allowed_origins = [o.strip() for o in origins.split(",") if o.strip()] or list(
            DEFAULT_ORIGINS
        )

