"""
2차 검문소 — 올라온 자료에 개인정보가 남아 있는지 훑는다.

1차는 폰이다 (`packages/core/src/transcription/deidentify.ts`). 여기는 그것이
제대로 돌았는지 확인하는 두 번째 문이지, 대신하는 문이 아니다. 폰에서 안 가리고
올린 것을 여기서 가려 주지 않는다 — **되돌려보낸다.** 가려 주기 시작하면
"서버가 알아서 하겠지" 하고 1차가 느슨해진다.

찾은 것을 화면이나 로그에 그대로 옮기지 않는다. 몇 건인지만 센다.
"""

from __future__ import annotations

import re

# 숫자 모양이 뚜렷한 것만 본다. 이름은 여기서 못 잡는다 — 이름은 폰의 몫이다.
PATTERNS: dict[str, re.Pattern[str]] = {
    # 주민등록번호 6-7
    "rrn": re.compile(r"\b\d{6}\s*[-–]\s*[1-4]\d{6}\b"),
    # 휴대전화 010-1234-5678, 01012345678
    "phone": re.compile(r"\b01[016-9][-–\s]?\d{3,4}[-–\s]?\d{4}\b"),
    # 등록번호로 보이는 8자리 이상 연속 숫자 (차트번호가 이 모양이다)
    "mrn": re.compile(r"\b\d{8,}\b"),
    # 이메일
    "email": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),
}


def screen_text(text: str) -> dict[str, int]:
    """남아 있는 개인정보 후보를 종류별로 센다. 값은 돌려주지 않는다."""
    found: dict[str, int] = {}
    for kind, pattern in PATTERNS.items():
        n = len(pattern.findall(text))
        if n:
            found[kind] = n
    return found


def screen_bundle(sentences: list[str]) -> dict[str, int]:
    """근무 꾸러미 전체를 한 번에 훑는다."""
    return screen_text("\n".join(sentences))
