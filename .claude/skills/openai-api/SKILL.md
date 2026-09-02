---
name: openai-api
description: OpenAI(GPT) API 를 부르는 코드를 쓰거나 고칠 때 반드시 먼저 읽는 참조. gpt-5.6 계열 모델 id·가격·컨텍스트 절벽, 추론 모델의 파라미터 제약(temperature 금지·max_completion_tokens·reasoning_effort), Structured Outputs, Batch API 3단 흐름(파일 업로드→배치→결과)을 담는다. 3a 추출 단계나 llm.ts 의 openai 분기를 만질 때, "GPT가 400을 던진다" 류 디버깅에 사용한다.
---

# OpenAI API 참조 (2026-08-30 공식 문서 검증)

기억으로 쓰지 말 것 — 이 파일이 낡아 보이면 developers.openai.com 을 다시
확인하고 이 파일을 갱신한다. NSR 은 SDK 금지(RN 번들 제약)라 전부 fetch.

## 모델 (gpt-5.6 세대)

| id | 성격 | 표준가 (입력/출력, 1M) | Batch |
|---|---|---|---|
| `gpt-5.6-sol` | 플래그십 추론 | $4 / $20 (프로모션 — 최소 2026-11-21 까지) | $2 / $10 |
| `gpt-5.6-terra` | 균형 | $2 / $12 | 절반 |
| `gpt-5.6-luna` | 저렴 | $0.20 / $1.20 | 절반 |

- Sol: 컨텍스트 1.05M(입력 상한 92.2만), 출력 최대 128K.
- **절벽: 입력 272K 초과 시 요청 전체가 입력 2배·출력 1.5배.** 전사본
  7~10만 토큰은 안전. 캐시 입력 $0.4/1M.

## 추론 모델 파라미터 규칙 (gpt-5 계열 공통)

- **`temperature`·`top_p`·penalty 류는 지원 안 함** — 보내면 400. 빼라.
- 출력 상한은 `max_tokens` 가 아니라 **`max_completion_tokens`**.
- `reasoning_effort`: `none | low | medium(기본) | high | xhigh | max`.
- **함정**: gpt-5.6 부터 Chat Completions 에서 **함수 도구 + reasoning_effort
  ≠ none 조합이 400** — "Function tools with reasoning_effort are not
  supported ... in /v1/chat/completions". 도구가 필요하면 Responses API
  (`/v1/responses`)를 쓰거나 effort 를 none 으로. NSR 3a 는 도구가 없으니
  Chat Completions + effort 그대로 가능.

## Structured Outputs

```json
"response_format": {
  "type": "json_schema",
  "json_schema": { "name": "...", "strict": true, "schema": { ... } }
}
```
- strict 스키마는 `additionalProperties: false` + 모든 키 `required` 필요.
- 응답은 `choices[0].message.content` 에 JSON 문자열로 온다 — 항상 파서를 거친다.

## Batch API (50% 할인, 24h 창)

3단 흐름 — Anthropic(1회 POST)과 다르다:

1. **JSONL 업로드**: `POST /v1/files` (multipart, `purpose: "batch"`) → `id`.
   줄 형식: `{"custom_id": "...", "method": "POST", "url": "/v1/chat/completions", "body": {...}}`
2. **배치 생성**: `POST /v1/batches`
   `{"input_file_id": "...", "endpoint": "/v1/chat/completions", "completion_window": "24h"}`
3. **폴링**: `GET /v1/batches/{id}` — `validating → in_progress → completed`
   (또는 `failed`/`expired`). 완료 후 `output_file_id` 를
   `GET /v1/files/{id}/content` 로 내려받는다. 실패분은 `error_file_id`.
   결과 줄: `{"id": "...", "custom_id": "...", "response": {"status_code", "body"}, "error"}`

- **결과는 순서 미보장 — custom_id 로만 매칭** (batch-ops 스킬 규칙).
- 한도: 배치당 5만 요청 / 파일 200MB.
- 지원 엔드포인트: chat/completions, responses, embeddings 등.

## 공통

- 인증: `Authorization: Bearer {key}` — 키는 보안 저장소에서만 (nsr-privacy).
- usage 는 `usage.prompt_tokens / completion_tokens`(+ 추론 토큰은
  `completion_tokens_details.reasoning_tokens`) — 제공사 구분해 로그로 남긴다.
- 429 는 크레딧/한도, 400 은 대부분 위 파라미터 규칙 위반이다.
