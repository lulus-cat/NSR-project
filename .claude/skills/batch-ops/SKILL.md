---
name: batch-ops
description: NSR 파이프라인의 Batch API 제출·폴링 패턴. Anthropic/OpenAI/Gemini 배치를 제출·조회·매칭하는 코드를 만들거나 고칠 때, 순차 의존 단계의 대기·재개를 다룰 때 반드시 사용한다. 폰 앱 환경의 복구 규칙(pipeline_jobs 저장, custom_id 매칭)이 여기 있다.
---

# Batch API 운영 규칙

배치는 50% 싸지만 폰 앱에서는 "기다림"이 위험이다 — 앱은 언제든 죽는다.
그래서 **모든 배치 상태는 DB(`pipeline_jobs`)에 남기고, 폴링은 "다음 한 걸음"
함수 하나로 몬다** (`checkDeepAnalysis` 패턴).

## 공통 규칙

- **결과는 순서 미보장.** 반드시 `custom_id` 로 매칭한다. 위치로 읽지 않는다.
- custom_id 규약: `{단계}-{shiftId}` (예: `3a-2026-08-29:D`).
- 순차 의존(3a→3v→3b→4): 앞 단계가 실패하면 **중단**한다. 다음 단계로 넘기지
  않고, 오류를 `pipeline_jobs.error` 에 남겨 화면이 보여주게 한다.
- 제출 직전에 죽는 틈을 막는다: "앞 단계 완료" 상태를 먼저 저장하고 제출한다
  (`3a-done` 패턴). 재개 함수는 이 중간 상태도 처리해야 한다.
- 단계별 `usage` 를 `appendPipelineUsage` 로 남긴다 — **제공사 구분** 필드 포함.
- SDK 금지(RN 번들 제약, nsr-android-build 규칙 5) — 전부 fetch REST.

## 제공사별 차이

### Anthropic (구현됨 — pipeline.ts 참고)
- 제출: `POST /v1/messages/batches` body `{requests:[{custom_id, params}]}` — 인라인.
- 조회: `GET /v1/messages/batches/{id}` → `processing_status === "ended"` 후
  `results_url` 에서 JSONL 다운로드. 줄마다 `{custom_id, result:{type, message}}`.
- 헤더: `x-api-key`, `anthropic-version: 2023-06-01`.

### OpenAI (하이브리드 3a)
- 3단계다: ① JSONL 을 `POST /v1/files` (purpose=batch) 업로드 → ② `POST /v1/batches`
  (input_file_id, endpoint="/v1/chat/completions", completion_window="24h") →
  ③ 상태 `completed` 후 `output_file_id` 내용 다운로드. 줄마다
  `{custom_id, response:{body}}`.
- 구현 전에 공식 문서로 현재 필드를 재확인한다 — 형식이 바뀌는 API 다.

### Gemini (하이브리드 3v·3b·4)
- Batch Mode: `POST /v1beta/models/{model}:batchGenerateContent` 계열
  (인라인 요청 또는 파일). 응답은 장기 실행 operation — 이름으로 폴링.
- 구현 전에 공식 문서로 현재 엔드포인트·응답 꼴을 재확인한다.

## 폴링 리듬

- 화면이 열려 있을 때: 30초 간격.
- 화면 밖: 폴링하지 않는다. 다음에 화면을 열거나 '진행 확인'을 누를 때 잇는다.
- 배치는 보통 수 분~수십 분, 최대 24시간이다. 사용자에게 이 폭을 정직하게
  말한다 ("몇 분에서 몇 십 분").
