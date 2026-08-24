# Google Stitch 프롬프트

디자인 시안용 프롬프트. **화면 하나씩** 돌린다 — 한 번에 전체를 시키면 화면끼리 톤이 어긋난다.

**결과물로 기대할 것**: 레이아웃과 정보 위계의 참고 이미지. 코드는 React Native가
아니라 그대로 못 쓴다. 보고 `theme.ts`·`ui.tsx`에 옮겨 적는 용도다.

**한글 문구**: 스티치는 영어 위주라 한글이 깨지거나 바뀔 수 있다.
프롬프트에는 한글을 그대로 적되, 결과에서 볼 것은 **글자가 아니라 배치**다.

---

## 구조 레퍼런스: ShopBack

레이아웃 문법을 여기서 가져왔다. 색은 안 가져온다 — 쇼핑 앱의 주황·분홍은
새벽에 보는 업무 도구에 안 맞는다. **가져오는 건 뼈대뿐이다.**

훔칠 동작 다섯 가지:

1. **컬러 헤더 + 흰 시트 오버랩** — 화면 위쪽이 색면이고, 콘텐츠 패널이
   그 위로 둥근 모서리를 물고 올라온다. 이 하나가 화면을 완성돼 보이게 만든다.
2. **헤더에 그 화면의 대표 숫자를 크게** — 그 아래에 label 왼쪽 / value 오른쪽
   breakdown 행 2~3개.
3. **시작 체크리스트 카드** — 컬러 제목띠 + 흰 목록 행 + 점선 구분선 + 화살표.
   처음 켠 사람이 뭘 해야 하는지 한 장으로.
4. **필터 칩 가로 행** — 목록 위에 얹는다. 활성 칩만 채운 색.
5. **밀도 있는 리스트 행** — 왼쪽 아이콘 사각형 + 제목 + 파란 보조문 + 오른쪽 값 +
   상태 pill. 그리고 **날짜 그룹 헤더**로 묶는다.

---

## 0. 공통 스타일 블록 — 매 프롬프트 앞에 붙인다

```
Android mobile app, portrait, 393×852.

Product: a private work journal for a first-year Korean hospital nurse.
It auto-records her shift, transcribes it on-device, turns it into study
cards, and tracks her working hours. Personal tool, nobody else sees it.
She opens it in a dim nurses' station at 3am, one-handed, in a hurry.

LAYOUT SYSTEM — follow this structure closely:
- Each screen has a COLORED HEADER ZONE at the top (roughly 180-260px tall)
  that bleeds under the status bar, containing the screen's single most
  important number in very large bold type, plus 2-3 breakdown rows
  (label left, value right) in the same colored zone.
- A WHITE/SURFACE CONTENT PANEL with large top corner radius (20-24px)
  overlaps upward into that colored zone and holds everything else.
  This overlap is essential — it is what makes the screen feel finished.
- Inside the panel: optional tab switcher with an underline indicator,
  then a horizontal row of FILTER CHIPS, then a dense list.
- Lists are grouped under DATE HEADERS (small, secondary color, left aligned).
- List rows are: small rounded icon square on the left, title, one-line
  secondary text, right-aligned value, and a small status pill.
  Hairline dividers between rows, not card gaps.
- Bottom tab bar, 5 tabs, icon + label: 홈 · 듀티 · 학습 · 용어 · 설정

COLOR — muted, dark-first. NOT a bright commercial palette.
- Dark mode is primary. Background #131312, surface panel #1C1C1A,
  raised #2B2B28, hairline #383733, body text #EAE7E1, secondary #9A968E.
- The colored header zone is a deep desaturated green (#1E332C to #2A4A3E,
  soft vertical gradient), NOT orange, NOT pink, NOT a bright gradient.
- One accent: #6FBFA4. One alert: #E08268. Nothing else carries color.
- Never pure black background with pure white text.
- Depth comes from surfaces getting lighter, never from drop shadows.

TYPOGRAPHY — system sans (Roboto). Letter-spacing 0 everywhere.
Hero number 40-48 bold tabular. Screen title 24/32 bold.
Section heading 18/24 bold. Row title 16/22 medium. Body 16/24 regular.
Meta 13/18 regular. Caption/pill 12/16 semibold.
Only three weights: 400 / 500 / 700.

SPACING — 16px screen side padding, 12px card radius, 8px between related
items, 24px between sections, 48px minimum touch target.

COPY — all Korean, 해요체. Buttons are verbs, never "확인"/"취소".
No trailing periods on buttons or labels.

FORBIDDEN: stock medical imagery, stethoscopes, crosses, heartbeat lines,
nurse illustrations, 3D coins, emoji, glassmorphism, bright gradients,
promotional banners, mascots.
```

---

## 1. 홈 — 가장 중요한 화면

```
[공통 스타일 블록]

Screen: Home tab.

COLORED HEADER ZONE (deep desaturated green, soft gradient):
- Top row: "오늘" as a large title on the left, a small circular icon
  button on the right.
- The hero block, centered:
    label "이번 주 근무" small and muted
    value "38.5시간" at 44px bold, tabular figures
- Three breakdown rows underneath, label left / value right,
  separated by nothing (just 8px gaps):
    야간              16시간
    초과              2.5시간      ← this value only, in the alert color
    연속 근무          4일

SURFACE PANEL overlapping upward into the header, 24px top radius:

1. RECORDING STATUS — the first block inside the panel and the loudest
   thing on the screen. Design BOTH states:
   (a) Idle — a filled row: small hollow dot, "녹음 대기" as the title,
       "다음 근무 · 8월 25일 데이 07:00" as secondary, and a full-width
       button "지금 녹음 시작".
   (b) Recording — the block is tinted with the accent color, a solid dot,
       "녹음 중", the elapsed time "02:14:37" at 32px bold tabular,
       "데이 근무 · 07:00 시작" secondary, and a destructive-tone
       full-width button "녹음 정지".
   Must be identifiable from across a dim room.

2. GETTING-STARTED CHECKLIST — only when setup is incomplete.
   A card with a tinted title strip reading "시작하기" and three rows
   under it separated by dashed dividers, each with a small icon square,
   a label, and a chevron:
      전사 모델 받기        (with a "필요" pill)
      듀티표 입력
      첫 근무 녹음하기
   Completed rows are dimmed with a check instead of a chevron.

3. "최근 근무" section header, then a DENSE LIST grouped by date header:
      8월 24일
      [icon] 데이 07:00–15:00   ·  전사 완료      2시간 12분   [카드 8장]
      [icon] 나이트 23:00–07:00 ·  전사 대기      7시간 40분   [대기]
   Row = icon square, title, secondary line, right-aligned duration,
   status pill. Hairline dividers.

Rules: no explanatory paragraphs anywhere. Every line is a value or a control.
```

---

## 2. 근무 기록 — 전사본

```
[공통 스타일 블록]

Screen: shift detail, opened from the home list.

COLORED HEADER ZONE:
- Back chevron left, "8월 24일 데이" centered, small icon button right.
- Hero: label "녹음" small, value "7시간 40분" at 40px bold.
- Breakdown rows:
    전사된 문장         324개
    화자 지정          12 / 324     ← alert color while incomplete

SURFACE PANEL overlapping upward:

- A three-tab switcher with an underline indicator: 전사 · 보고서 · 근무 환경.
  Show the 전사 tab active.
- A horizontal FILTER CHIP row directly under it:
    전체 · 본인 · 선배 · 의사 · 미확인
  with 미확인 active (filled with the accent color).
- Then the TRANSCRIPT LIST, grouped by a time header ("07:12"):
  each row is a sentence —
    a narrow colored speaker bar on the left edge,
    a small speaker pill (본인 / 선배 / 미확인),
    the sentence text at 16/24 wrapping to at most 3 lines,
    a timestamp small and right-aligned.
  Hairline dividers, no card gaps. This must read like a transcript,
  long and scannable.
- Show one row in a "range start selected" state, outlined in the accent color.

- A floating bar pinned above the bottom tab bar while assigning speakers:
  role chips 본인 · 선배 · 의사 · 환자 · 보호자 · 기타 in one horizontal row
  with 선배 selected, plus a small hint line "시작 문장과 끝 문장을 누르세요".
```

---

## 3. 듀티표

```
[공통 스타일 블록]

Screen: Duty tab.

COLORED HEADER ZONE:
- Title "듀티표" left, month stepper "2026년 8월" with ‹ › on the right.
- Hero: label "이번 달" small, value "18일 근무" at 40px bold.
- Breakdown rows:
    데이 · 이브닝 · 나이트      7 · 6 · 5
    오프                      13일

SURFACE PANEL overlapping upward:

1. A MONTH CALENDAR GRID, 7 columns, the dominant element of this screen.
   Each day cell is compact: the date number small in the top-left corner,
   and the shift code as a filled rounded chip filling the rest of the cell —
   D / E / N / OFF / EDU. Each code has its own muted tone;
   OFF is an outline only, not filled. Today's cell carries a ring.
   Do NOT turn days into cards. It must read as a calendar.

2. Under the grid, a compact legend row of small chips.

3. A collapsible paste block: a row "듀티표 붙여넣기" with a chevron that
   expands into a multiline field with placeholder
   "DDEENNOO 또는 데데이이나나오오" and a right-aligned button "적용".
   Collapsed by default — it is a setup action, not a daily one.

4. A settings row "근무 시간 설정" with a chevron.
```

---

## 4. 학습 — 카드 복습

```
[공통 스타일 블록]

Screen: Study tab, single flashcard review.

COLORED HEADER ZONE, shallower than other screens (about 140px):
- Title "복습" left, a small close/exit icon right.
- A thin progress bar spanning the width, with "7 / 12" right-aligned above it.

SURFACE PANEL overlapping upward, holding one large card:
- The card fills most of the remaining height, generous internal padding.
- Term "노티" at 36px bold, positioned slightly above center.
- Under it a small muted pill "우리 병동 말".
- A single wide button pinned at the bottom of the panel: "답 보기".

Design the REVEALED state as a second frame:
- The term shrinks to 24px and moves to the top of the card.
- The definition appears at 16/24.
- A "주의점" block sits below in a subtly tinted container with a left accent bar.
- The bottom becomes four equal-width grading buttons in one row:
    다시 · 어려움 · 보통 · 쉬움
  Only 쉬움 filled with the accent; the rest are neutral outlines.

Calm and uncluttered — this is used while exhausted.
```

---

## 5. 설정

```
[공통 스타일 블록]

Screen: Settings tab.

COLORED HEADER ZONE, shallow (about 150px):
- Title "설정" left.
- Hero: label "저장된 녹음" small, value "1.2 GB" at 40px bold.
- One breakdown row with a thin usage bar underneath:
    보관 한도            4 GB

SURFACE PANEL overlapping upward — a GROUPED SETTINGS LIST.
Sectioned, hairline dividers, section headers small and secondary.
NOT a stack of cards with paragraphs.

자동 녹음
- toggle "듀티표에 따라 자동 녹음"
- value row "녹음할 근무"        D · E · N
- value row "근무 시작 전"        40분
- value row "보관 기간"          30일

조용히 동작
- toggle "시작·종료 소리 없음"
- toggle "알림 표시 안 함"

개인정보
- toggle "앱 잠금"
- toggle "본인 음성 없는 구간 자동 폐기"
- navigation row "내보낼 때 가리기"   이름 · 전화번호 · 등록번호

전사
- navigation row "전사 모델"      Small (양자화)   with a "2개 받음" pill
- navigation row "병동 사전"      3개

Each row at least 48px tall. Values right-aligned in secondary color.
At most one or two rows carry a line of helper text — not all of them.
```

---

## 6. 스티치에 시키지 말 것

- **"의료 앱처럼"** — 하늘색 십자가와 청진기가 나온다. 이건 개인 업무 도구다.
- **"예쁘게" / "모던하게"** — 그라데이션과 유리 효과가 붙는다.
- **ShopBack 색을 그대로** — 주황·분홍은 새벽 근무에 안 맞는다. 뼈대만 가져온다.
- **화면 여러 개를 한 프롬프트에** — 톤이 어긋난다.
- **밝은 모드 먼저** — 야간이 기본 사용 환경이다. 다크를 먼저 뽑는다.

## 7. 받은 시안에서 확인할 것

- **흰 패널이 컬러 헤더를 실제로 덮고 있는가** — 겹침이 없으면 그냥 두 덩어리로 보인다
- 헤더의 대표 숫자가 한눈에 읽히는가
- 리스트가 **행**인가 카드인가 — 카드면 밀도가 죽는다
- 설명 문단이 있는가 — 도구에는 값과 조작만 있어야 한다
- 숫자가 고정폭인가 (시간이 흔들리면 눈이 피로하다)
- 다크에서 **표면이 배경보다 밝아서** 층이 보이는가
