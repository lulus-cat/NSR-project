"""
폰 잇기 — VPS 에서 명령 한 줄, 폰에서 QR 한 번.

왜 이 길인가
-----------
처음에는 서버의 기기 토큰을 사람이 복사해 앱에 붙여넣었다. 폰에서 40자짜리
무작위 글자를 오타 없이 넣는 일은 생각보다 괴롭고, 그 값이 메모장이나 대화
기록에 남는다. 구글 로그인도 붙여 뒀지만(README 8번) 그건 구글 콘솔에서
사람이 클릭해야 하는 준비가 있다.

이 길은 준비가 없다.
  1. VPS 에서  python -m nsr_server.pair
  2. 나온 주소를 컴퓨터 브라우저로 연다 → 큰 QR 이 뜬다
  3. 폰 카메라로 찍고 '앱 열기' 를 누른다 → 끝

쪽지(claim)는 15분 뒤 사라지고 한 번 쓰면 없어진다. 열쇠 자체는 QR 에 들어
있지 않다 — 폰이 그 쪽지를 HTTPS 로 열쇠와 바꾼다. 그래서 QR 을 남이 어깨너머로
찍어도, 먼저 바꾼 쪽만 열쇠를 갖는다(그리고 그 사실이 서버에 남는다).
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from .store import Store

PAIR_TTL = 60 * 15  # 컴퓨터와 폰 사이를 오갈 시간


def new_pairing(store: Store, label: str = "QR 로 이은 기기") -> str:
    """일회용 쪽지를 만들어 그 코드를 준다. 열쇠는 폰이 주우러 올 때 만든다."""
    code = secrets.token_urlsafe(24)
    store.put_oauth_pending(
        f"claim-{code}",
        {"email": "(qr)", "label": label},
        expires_at=time.time() + PAIR_TTL,
    )
    return code


def svg_qr(url: str) -> str | None:
    """QR 을 그림(SVG)으로. qrcode 가 없으면 None — 화면이 주소만 보여 준다."""
    try:
        import io

        import qrcode
        import qrcode.image.svg
    except ImportError:
        return None
    q = qrcode.QRCode(box_size=10, border=2)
    q.add_data(url)
    q.make(fit=True)
    buffer = io.BytesIO()
    q.make_image(image_factory=qrcode.image.svg.SvgPathImage).save(buffer)
    svg = buffer.getvalue().decode("utf-8")
    # <?xml …?> 선언은 페이지 안에 박아 넣을 때 방해가 된다.
    return svg[svg.index("<svg") :]


def ascii_qr(url: str) -> str | None:
    """터미널에서 바로 찍을 수 있게. 글꼴에 따라 찌그러지면 위 주소를 쓴다."""
    try:
        import io

        import qrcode
    except ImportError:
        return None
    q = qrcode.QRCode(border=2)
    q.add_data(url)
    q.make(fit=True)
    out = io.StringIO()
    q.print_ascii(out=out, invert=True)
    return out.getvalue()


def main() -> None:
    from .config import Config

    config = Config()
    if not config.public_host:
        raise SystemExit("NSR_PUBLIC_HOST 가 비어 있습니다. 바깥 도메인을 먼저 넣으십시오.")
    store = Store(config.db_path)
    code = new_pairing(store)
    base = f"https://{config.public_host}"
    show, link = f"{base}/pair/{code}/qr", f"{base}/pair/{code}"

    print()
    print("폰 잇기 — 15분 안에 하세요.")
    print()
    print("  1) 컴퓨터 브라우저에서 이 주소를 여세요 (큰 QR 이 나옵니다)")
    print(f"     {show}")
    print()
    print("  2) 폰 카메라로 QR 을 찍고, 뜨는 알림을 누르세요")
    print("     NSR 앱이 열리면서 '연결됐어요' 가 뜨면 끝입니다")
    print()
    print("  QR 이 안 되면 폰 브라우저에 이 주소를 직접 여세요")
    print(f"     {link}")
    art = ascii_qr(link)
    if art:
        print()
        print(art)
    else:
        print()
        print("  (터미널 QR 을 보려면: pip install qrcode)")


if __name__ == "__main__":
    main()
