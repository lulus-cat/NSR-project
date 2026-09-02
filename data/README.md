# data/ — 녹음·전사본 작업 폴더

여기 넣는 파일 대부분은 **환자 정보가 들어 있는 원본**이다. 그래서 `.gitignore` 가
아래 폴더를 통째로 막는다. 깃허브에 올라가는 것은 `corrections/` 와 이 README 뿐이다.

```
data/
├── recordings/     녹음 원본 (m4a·wav·mp3)          — 커밋 안 됨
├── transcripts/    전사본 (콜랩 JSON·SRT·TXT·앱 MD)   — 커밋 안 됨
├── reviews/        tools/review-transcript.mjs 출력   — 커밋 안 됨
└── corrections/    확정된 교정 규칙 (JSONL)           — 커밋 됨. 개인정보 없음
```

## 전사본 파일 이름

`YYYY-MM-DD_근무_순번.확장자` 로 맞추면 질문에 나오는 파일명만 보고도 어느 근무인지 안다.
예: `2026-08-24_D_01.json`, `2026-08-24_D_02.srt`.

## 받는 형식

| 어디서 | 형식 | 비고 |
| --- | --- | --- |
| 콜랩 전사 서버 (`docs/colab`) | `verbose_json` (`{text, segments:[{start,end,text}]}`) | 시각이 초 단위로 들어 있다 |
| 다글로·클로바 등 | `.srt` / `.vtt` | 화자 표기가 있으면 살린다 |
| 아무 메모 | `.txt` | 줄 앞에 `[hh:mm:ss]` 가 있으면 시각으로 읽는다 |
| NSR 앱 내보내기 | `.md` | 앱이 이미 1차 교정을 했다. 검토 도구는 원문(rawText)이 있으면 그걸 쓴다 |

## 흐름

1. 파일을 `transcripts/` 에 넣는다.
2. `node tools/review-transcript.mjs data/transcripts/<파일>` — 결정적 1차 교정과 후보 목록이
   `reviews/<파일>.review.md` 로 나온다. 질문 부분은 개인정보가 가려져 있어 그대로 붙여넣어도 된다.
3. Claude 가 `nsr-transcript-review` 스킬 절차대로 후보를 판정하고, 못 정한 것은 파일명·시각·문장과 함께 묻는다.
4. 답을 주면 `corrections/confirmed.jsonl` 에 확정 규칙이 쌓이고, 다음 검토부터 자동 적용된다.
5. 같은 오인식이 반복되면 `packages/core/src/lexicon/misheard.ts` 로 승격한다 (테스트와 함께).

## corrections/confirmed.jsonl 한 줄의 모양

```json
{"from":"노디","to":"노티","kind":"B","entryId":"notify","decidedAt":"2026-09-02","note":"인계 문맥. 3회 반복"}
```

- `kind` — A 반복 환각 / B 임상 어휘 부재 / C 순수 한글 오독 (`nsr-transcript-review` 참고)
- 문장 원문·환자 정보는 넣지 않는다. 규칙만 넣는다.
