# NSR — Claude 작업 지침

신규간호사 근무 녹음 → 전사 → 교정 → 학습카드 앱. 사용자는 비개발자이며, 이 저장소의 코드는
대부분 Claude 가 쓴다. **모든 세션(Fable·Opus 어느 모델이든)은 이 파일을 먼저 읽는다.**

## 저장소 지도

| 경로 | 무엇 | 검증 |
| --- | --- | --- |
| `packages/core/` | 플랫폼 독립 도메인 로직 (한글 음운, 사전, 전사 교정, 태움, 학습, 듀티) | `npm test` (vitest 314+), `npm run typecheck` |
| `apps/mobile/` | Expo 57 / RN 0.86 앱. 화면·저장·녹음·네이티브 모듈만 담당 | `cd apps/mobile && npx tsc --noEmit` |
| `apps/mobile/modules/nsr-audio-decode/` | 로컬 Expo 네이티브 모듈 (m4a→wav, 포그라운드 서비스) | APK CI |
| `tools/` | 저장소 운영 스크립트 (판 점검, 전사본 검토, 스킬 업로드) | 실행해 본다 |
| `docs/` | 설계 근거. 01 법·개인정보, 02 전사 파이프라인, 03 도구 조사, 07 전사 검토 워크플로 | — |
| `data/` | 녹음·전사본 작업 폴더. **환자 정보가 들어 있어 대부분 gitignore** (`data/README.md`) | — |
| `.github/workflows/` | `build-apk.yml` (main·claude/** 푸시마다 APK → Releases prerelease), 모델 릴리스 | — |

## 명령

```bash
npm ci && npm test && npm run typecheck          # core. 커밋 전 반드시
cd apps/mobile && npm ci && npx tsc --noEmit     # 앱 타입체크 (Expo Go 로는 못 돌린다 — 네이티브 모듈)
node tools/check-expo-versions.mjs apps/mobile   # 네이티브 의존성 건드렸으면 반드시
node tools/review-transcript.mjs data/transcripts/<파일>   # 전사본 1차 검토 → 판정표·질문
```

앱 실행 검증은 CI 가 만든 APK 를 폰에 설치해서 한다. 이 환경에서는 안드로이드 빌드가 안 돈다.

## 스킬 — 언제 무엇을 읽나

`.claude/skills/` 에 있다. 이름을 부르지 않아도 해당 작업이면 먼저 읽는다.

**이 저장소 고유 규칙 (반드시)**
- `nsr-transcript-review` — 전사본 검토·교정·질문. 녹음본/전사 파일이 들어오면 항상.
- `nsr-privacy` — 전사본·녹음·사전이 기기 밖으로 나가는 코드 전부 (LLM 호출 포함).
- `nsr-design` — 화면·컴포넌트·색·글자.
- `nsr-android-build` — APK·CI·gradle·네이티브 의존성.

**작업 방식 (외부에서 가져옴, MIT — `.claude/skills/THIRD_PARTY_NOTICES.md`)**
- `test-driven-development` — core 에 기능·버그 수정을 넣을 때. 테스트 먼저.
- `systematic-debugging` — 테스트 실패·빌드 실패·이상 동작. 원인 먼저, 고치기는 나중.
- `verification-before-completion` — "됐다"고 말하기 전. 명령을 실제로 돌린 출력이 근거.

**Expo (공식 expo/skills 에서 가져옴)**
- `expo-overview` → 라우터. Expo 작업이면 먼저 읽고 아래로 간다.
- `expo-router`, `expo-module`(로컬 네이티브 모듈), `expo-dev-client`, `expo-upgrade`(SDK 올릴 때).

## 절대 규칙

1. `rawText`(ASR 원문)와 원본 오디오는 어떤 경우에도 덮어쓰지 않는다. 교정은 별도 레코드.
2. 전사본·녹음·위치·태움 점수는 기기 밖으로 나가지 않는 것이 기본값. 나가는 길은 전부 `redactForNetwork` 를 거친다.
3. `data/` 안의 전사본·녹음·검토 결과를 커밋하지 않는다. 확정된 **교정 규칙만** (`data/corrections/`) 커밋한다.
4. 화자가 실제로 한 말(은어 "폴리")은 고치지 않는다. 음성인식이 틀린 것("포리")만 고친다.
5. 커밋 전: `npm test` · `npm run typecheck` · 앱 타입체크. 통과 출력을 본 뒤에만 "통과"라고 쓴다.
6. 코드 주석·문서·화면 문구는 한국어. 화면은 합니다체.
7. API 키는 `expo-secure-store` 에만. 저장소·로그·설정 DB 에 넣지 않는다.

## 사용자와 대화할 때

- 비개발자다. 용어는 풀어서 쓰고, 명령은 복사해서 붙일 수 있게 코드 블록으로.
- 판독 불가 전사는 추측해서 확정하지 말고 `nsr-transcript-review` 의 질문 형식으로 묻는다 (파일명·시각·문장).
- 환자 실명·등록번호는 답변에 옮기지 않는다. 환자A·환자B 로 부른다.
