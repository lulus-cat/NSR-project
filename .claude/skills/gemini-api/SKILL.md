---
name: gemini-api
description: 구글 Gemini API 를 부르는 코드를 쓰거나 고칠 때 반드시 먼저 읽는 참조. 모델 id·가격 절벽, 네이티브 generateContent 와 OpenAI 호환 게이트웨이의 차이, response_schema(대문자 타입), Files 재개형 업로드, Batch Mode, google_search 그라운딩, 함수 호출(functionDeclarations), 전용 전사(Interactions API)를 담는다. 3v·3b·4·5·5b 단계나 asr.ts/llm.ts 의 gemini 분기를 만질 때 사용한다.
---

# Gemini API 참조 (2026-08-30 공식 문서 검증)

기억으로 쓰지 말 것 — 낡아 보이면 ai.google.dev 를 다시 확인하고 이 파일을
갱신한다. NSR 은 SDK 금지 — 전부 fetch. 동작하는 실전 예가 저장소에 있다:
업로드·generateContent·Interactions 는 `asr.ts`, 호환 게이트웨이는 `llm.ts`,
실시간 4단계는 `pipeline.ts`.

## 모델과 가격 (입력/출력, 1M · Batch 는 절반)

| id | 성격 | 표준가 | 절벽 |
|---|---|---|---|
| `gemini-3.7-flash` | 최신 Flash | $0.75/$3.75 (프로모션, 2026-12 까지 → 이후 $1.50/$7.50) | **없음** (1.05M 전 구간) |
| `gemini-3.1-pro-preview` | Pro 최신 (프리뷰, **무료 티어 없음**) | $2/$12 | **200K 초과 시 $4/$18** |
| `gemini-3.5-flash-lite` | 최저가 | $0.30/$2.50 | 없음 |
| `gemini-3.5-transcribe` | 전용 전사 (Interactions API) | 분당 ≈$0.005 | 화자 분리 시 30분/끄면 60분 |

"3.1-pro" 라고 쓰면 404 — **`-preview` 접미사까지가 id 다.**

## 두 호출 경로 — 섞지 말 것

1. **네이티브** `POST /v1beta/models/{model}:generateContent?key=` —
   `system_instruction.parts[].text`, `contents[].parts[]`,
   `generationConfig { temperature, max_output_tokens, response_mime_type:
   "application/json", response_schema }`. **response_schema 타입은 대문자**
   (`OBJECT/ARRAY/STRING/NUMBER/BOOLEAN`). 도구·검색·배치는 이 경로만 된다.
2. **OpenAI 호환 게이트웨이** `/v1beta/openai/chat/completions` —
   llm.ts 의 callOpenAi 가 쓰는 경로. 여기서는 `max_tokens`
   (max_completion_tokens 아님), 소문자 JSON 스키마(response_format).

## 도구

- **google_search 그라운딩**: `"tools": [{"type": "google_search"}]`
  (2026 문서 기준 typed 선언; 구형 `{"google_search": {}}` 를 쓰는 예제도
  아직 돈다 — 400 이면 다른 형태로). 응답의 grounding metadata 에 출처가 온다.
- **함수 호출**: `"tools": [{"functionDeclarations": [{name, description,
  parameters: {type: "object", properties, required}}]}]` (여기 스키마는
  소문자 타입). 모델이 `parts[].functionCall {name, args}` 를 돌려주면
  실행 후 `parts[].functionResponse {name, response}` 로 되돌린다.
  내장 도구(google_search)와 한 요청에 섞을 수 있다.

## Files API (긴 오디오·대용량 입력)

재개형 업로드: `POST /upload/v1beta/files?key=` 에
`x-goog-upload-protocol: resumable` + `x-goog-upload-command: start` →
응답 헤더 `x-goog-upload-url` 로 본문 업로드(`upload, finalize`) →
`file.state` 가 `ACTIVE` 될 때까지 폴링 → `file.uri` 를 `file_data` 로 참조.
48시간 뒤 자동 삭제, 민감 데이터는 즉시 DELETE (asr.ts 패턴).

## Batch Mode (50% 할인)

- 생성: `POST /v1beta/models/{model}:batchGenerateContent`
  - **인라인** (합계 20MB 미만): 요청 목록을 직접 실음. 각 요청에
    `key`(= custom id) 를 붙인다 — 응답 매칭은 이 key 로만 한다.
  - **파일**: JSONL `{"key": "...", "request": {...}}` 을 Files API 로 올리고
    fileName 참조 (최대 2GB).
- 폴링: `GET /v1beta/{batchName}` — `JOB_STATE_PENDING → RUNNING →
  SUCCEEDED | FAILED | CANCELLED | EXPIRED(48h)`. 결과는 인라인이면
  `inlinedResponses`, 파일이면 `dest.fileName`. 결과 보존 6주.
- **배치 안에서 google_search·response_schema·system instruction 전부
  지원된다** (2026-08 문서 확인) — 3b 를 배치로 돌릴 수 있는 근거.
- 목표 처리 24시간, 대개 훨씬 빠름.

## 전용 전사 (gemini-3.5-transcribe)

generateContent 가 아니라 `POST /v1beta/interactions` (헤더
`x-goog-api-key`). 단어 주석(`word_info`: text/speaker/`"0.100s"` 오프셋)
파싱·문장 묶기 구현은 asr.ts `geminiTranscribeInteraction` 이 정본.

## 공통

- 인증: 네이티브는 `?key=` 또는 `x-goog-api-key`, 게이트웨이는 Bearer.
- usage: 네이티브 `usageMetadata`, 게이트웨이 `usage` — 제공사 구분 로그.
- 무료 티어는 입력이 학습에 쓰일 수 있다(유료는 아님) — 화면 고지 유지.
