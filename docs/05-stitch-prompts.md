# Google Stitch 프롬프트

디자인 시안을 뽑기 위한 프롬프트 모음. 화면마다 따로 돌린다 —
"앱 전체를 디자인해줘"로 한 번에 시키면 화면끼리 따로 놀고 우리 기능과 안 맞는 것이 나온다.

**스티치 결과물로 기대할 것**: 레이아웃과 정보 위계의 참고 이미지. 코드는 React Native가
아니므로 그대로 못 쓴다. 보고 우리 `theme.ts`·`ui.tsx`에 옮겨 적는 용도다.

**한국어 문구**: 스티치는 영어 위주라 한글이 깨지거나 다른 말로 바뀔 수 있다.
프롬프트에는 한글 문구를 그대로 적되, **결과에서 볼 것은 글자가 아니라 배치**다.

---

## 0. 공통 스타일 블록 — 매 프롬프트 앞에 붙인다

```
Android mobile app, portrait, 393×852.

Product: a private work-journal app for a first-year Korean hospital nurse.
It records her shift, transcribes it on-device, turns it into study cards,
and tracks her working hours. It is a personal tool, not a hospital system.
Nobody else sees this screen. She opens it in a dim nurses' station at 3am,
often one-handed, often in a hurry.

Design direction:
- Dense productivity tool, NOT a wellness or medical-consumer app.
  Think a note-taking or time-tracking app, not a hospital dashboard.
- No stock medical imagery. No stethoscopes, no crosses, no heartbeat lines,
  no illustrations of nurses, no gradients, no glassmorphism.
- Muted, low-chroma palette. Dark mode is the primary mode.
  Dark: background #131312, card surface #1C1C1A, raised surface #2B2B28,
  hairline border #383733, body text #EAE7E1, secondary text #9A968E,
  single accent #6FBFA4 (desaturated green), alert #E08268.
  Never pure black background with pure white text.
  Depth comes from surfaces getting lighter, not from drop shadows.
- Typography: system sans (Roboto). Letter-spacing 0 everywhere.
  Screen title 24/32 bold, section heading 18/24 bold,
  card title 16/22 medium, body 16/24 regular, meta 13/18 regular,
  caption 12/16 semibold. Only three weights: 400 / 500 / 700.
- 16px screen side padding, 12px card radius, 8px between related items,
  24px between sections. Minimum touch target 48px.
- Bottom tab bar, 5 tabs, text labels only, no icons:
  홈 · 듀티 · 학습 · 용어 · 설정
- All UI text in Korean, polite informal register (해요체).
  Buttons are verbs, never "확인"/"취소". No trailing periods on buttons or labels.
```

---

## 1. 홈 — 가장 중요한 화면

```
[공통 스타일 블록]

Screen: Home tab, titled "오늘".

Top to bottom:

1. RECORDING STATUS — the single most prominent element on the screen.
   A card that must be readable at a glance from arm's length.
   Two states, design both:
   (a) Idle: small grey dot, "녹음 대기", one line of secondary text
       "다음 근무 · 8월 25일 데이 07:00 시작", and a full-width
       primary button "지금 녹음 시작".
   (b) Recording: the accent color as the card background tint,
       a filled dot, "녹음 중", elapsed time in large tabular figures
       "02:14:37", secondary line "데이 근무 · 07:00 시작",
       and a full-width destructive button "녹음 정지".
   The recording state should be unmistakable from across a room.

2. TODAY'S SHIFT — compact row block, not a big card.
   "오늘 근무" heading, then "데이 07:00–15:00" as the primary line and
   "인계 포함 06:20–15:30" as a secondary line, with a chevron to open details.

3. STUDY — one row: "복습" heading, "오늘 볼 카드 12장" and a chevron.
   If the count is zero, the row reads "복습할 카드 없음" in secondary color.

4. THIS WEEK — a compact 4-up stat strip, NOT four separate cards.
   Labels tiny, numbers large and tabular:
   근무 38.5시간 · 야간 16시간 · 초과 2.5시간 · 연속 4일
   If 초과 is above zero, tint just that number with the alert color.

Rules for this screen:
- No explanatory paragraphs anywhere. Every line is either a value or a control.
- The whole screen fits on one phone screen without scrolling in the common case.
- Total of at most 4 visual blocks. Do not turn each item into its own large card.
```

---

## 2. 근무 기록 — 전사본 보기

```
[공통 스타일 블록]

Screen: shift detail, header "8월 24일 데이".
Three segmented tabs at the top: 전사 · 보고서 · 근무 환경. Show the 전사 tab.

Above the list, a slim status bar showing speaker-labelling progress:
"32개 중 12개 지정" with a thin progress bar and one line of secondary text.

Then a vertical list of TRANSCRIPT SENTENCES. Each sentence is one row:
- a small speaker chip on the left edge (본인 / 선배 / 의사 / 환자 / 미확인),
  color-coded but muted — 본인 in accent, 미확인 in a warning tone, others neutral
- the sentence text, 16/24, wrapping to at most 3 lines
- timestamp "01:14" small, right-aligned, secondary color
- rows are separated by hairlines, not by card gaps — this is a dense reading list

Show one row in a selected state (it is the start of a speaker range being assigned):
outlined with the accent color.

At the bottom, a floating action bar that appears while assigning speakers:
role chips 본인 · 선배 · 의사 · 환자 · 보호자 · 기타 in a horizontal row,
with 선배 selected, and a text hint "시작 문장과 끝 문장을 누르세요".

This must read like a transcript reader — long, scannable, dense —
not like a feed of cards.
```

---

## 3. 듀티표

```
[공통 스타일 블록]

Screen: Duty tab, header "듀티표".

1. A paste box at the top: a multiline text field with placeholder
   "DDEENNOO 또는 데데이이나나오오", label "듀티표 붙여넣기",
   and a button "적용" aligned to the right below it.
   One line of secondary help text under it.

2. A MONTH CALENDAR GRID, 7 columns.
   Each day cell is compact: the date number small in the corner, and the
   shift code as a filled rounded chip filling most of the cell —
   D / E / N / OFF / EDU. Each code has its own muted color;
   OFF is just an outline, not filled. Today's cell has a ring.
   The grid is the main content of this screen and should dominate it.

3. Below the grid, a compact legend row and a "근무 시간 설정" row with a chevron.

Do not make each day a large card. This is a calendar, it must feel like one.
```

---

## 4. 학습 — 카드 복습

```
[공통 스타일 블록]

Screen: Study tab, a single flashcard review view.

- A thin progress bar at the very top: "7 / 12".
- The card fills most of the screen: a large surface with generous padding,
  the term "노티" in 32px bold, centered vertically but slightly above center,
  and below it a small muted chip "우리 병동 말".
- A single wide button at the bottom: "답 보기".
- Design the revealed state too: the answer text appears in 16/24 body,
  a short "주의점" block in a subtly tinted container below it,
  and the bottom becomes four grading buttons in one row:
  다시 · 어려움 · 보통 · 쉬움
  — equal width, only 쉬움 in accent, the rest neutral outlines.

Keep it calm and uncluttered. This is used while tired.
```

---

## 5. 설정

```
[공통 스타일 블록]

Screen: Settings tab, header "설정".

A grouped settings list — iOS/Android settings style, sectioned,
hairline dividers, section headers in small caps-ish secondary text.
NOT a stack of cards with paragraphs.

Sections and rows:

자동 녹음
- toggle row "듀티표에 따라 자동 녹음"
- value row "녹음할 근무" → "D · E · N"
- value row "근무 시작 전" → "40분"
- value row "보관 기간" → "30일"
- value row "사용 중" → "1.2 GB / 4 GB" with a thin usage bar

조용히 동작
- toggle "시작·종료 소리 없음"
- toggle "알림 표시 안 함"

개인정보
- toggle "앱 잠금"
- toggle "본인 음성 없는 구간 자동 폐기"
- navigation row "내보낼 때 가리기" → "이름 · 전화번호 · 등록번호"

전사
- navigation row "전사 모델" → "Small (양자화) · 받아 둔 것 2개"
- navigation row "병동 사전" → "3개"

Each row is at least 48px tall. Values are right-aligned in secondary color.
Only one or two rows may carry a single line of helper text — not all of them.
```

---

## 6. 스티치에 시키지 말 것

결과가 안 좋아지는 요청들.

- **"의료 앱처럼"** — 하늘색 + 십자가 + 청진기 일러스트가 나온다. 이 앱은 개인 업무 도구다.
- **"예쁘게" / "모던하게"** — 그라데이션과 유리 효과가 붙는다. 대신 참고할 앱의 **성격**을 적는다.
- **화면 여러 개를 한 프롬프트에** — 화면끼리 톤이 어긋난다.
- **아이콘 지정** — 우리는 아이콘 라이브러리를 안 쓴다. 아이콘 없이 되는 배치를 받아야 한다.
- **밝은 모드 먼저** — 이 앱의 기본 사용 환경은 야간이다. 다크를 먼저 뽑고 밝은 모드를 나중에 맞춘다.

## 7. 받은 시안에서 확인할 것

- 한 화면에 **덩어리가 4개를 넘는가** → 넘으면 정보 위계가 없는 것이다
- 설명 문단이 있는가 → 도구에는 설명이 아니라 값과 조작만 있어야 한다
- **녹음 중 상태가 멀리서 구분되는가**
- 숫자가 고정폭인가 (시간·용량이 흔들리면 눈이 피로하다)
- 다크에서 **표면이 배경보다 밝아서** 층이 보이는가 (그림자로 층을 만들면 다크에서 안 보인다)
