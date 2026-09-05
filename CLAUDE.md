# NSR — Claude 작업 지침

신규간호사 근무 녹음 → 전사 → 교정 → 학습카드 앱. 사용자는 비개발자이며, 이 저장소의 코드는
대부분 Claude 가 쓴다. **모든 세션(Fable·Opus 어느 모델이든)은 이 파일을 먼저 읽는다.**

## 시작하기 전에 — 최신 판이 이 브랜치에 있는가

APK 판 번호는 CI 가 **태그 최고값 +1** 로 매긴다. 어느 브랜치에서 푸시하든 그렇다.
그래서 낡은 브랜치에서 푸시하면 **기능이 빠진 판이 "최신"** 이 되어 폰에 깔린다
(0.1.56 사고 — 기본 브랜치가 24개 커밋 뒤처져 있었다). 작업 전에 반드시 확인한다.

```bash
git fetch --all --tags
LATEST=$(git tag --sort=-v:refname | head -1)
git merge-base --is-ancestor $LATEST HEAD && echo "최신 판($LATEST) 포함 — 진행" \
  || { echo "최신 판($LATEST)이 이 브랜치에 없다. 먼저 합친다:"; git branch -r --contains $LATEST; }
```

없다고 나오면 그 브랜치를 `git merge` 로 합친 뒤에 시작한다. 합치지 않고 푸시하지 않는다.

## 저장소 지도

| 경로 | 무엇 | 검증 |
| --- | --- | --- |
| `packages/core/` | 플랫폼 독립 도메인 로직 (한글 음운, 사전, 전사 교정·검토, 태움, 학습, 듀티) | `npm test` (vitest 330+), `npm run typecheck` |
| `apps/mobile/` | Expo 57 / RN 0.86 앱. 화면·저장·녹음·네이티브 모듈. 전사는 콜랩·PC 서버로 보낸다 (온디바이스 whisper.rn 은 0.1.5x 에서 뺐다) | `cd apps/mobile && npx tsc --noEmit` |
| `apps/mobile/src/services/pipeline.ts`, `llm.ts`, `asr.ts` | 심층 분석 파이프라인(추출→검증→조사→보고서), LLM 경로, 전사 서버 연결 | 위와 같음 |
| `apps/mobile/src/services/tiro-notes.ts` | 티로 노트 가져오기. 티로가 계정에 '파일 전사'를 안 켜 주면 업로드 길이 403 으로 막혀서, 티로 앱이 이미 전사한 노트를 읽어 온다 | 위와 같음 |
| `apps/mobile/modules/nsr-audio-decode/` | 로컬 Expo 네이티브 모듈 (m4a→wav, 포그라운드 서비스) | APK CI |
| `tools/` | 저장소 운영 스크립트 (판 점검, 전사본 검토, 스킬 업로드, 릴리스 노트) | 실행해 본다 |
| `docs/` | 설계 근거. 01 법·개인정보, 02 전사 파이프라인, 03 도구 조사, 07 전사 검토 워크플로, `colab/` 전사 서버 노트 | — |
| `data/` | 녹음·전사본 작업 폴더. **환자 정보가 들어 있어 대부분 gitignore** (`data/README.md`) | — |
| `.github/workflows/` | `build-apk.yml` (claude/** 푸시마다 APK → Releases prerelease), 모델 릴리스 | — |

## 명령

```bash
npm ci && npm test && npm run typecheck          # core. 커밋 전 반드시
cd apps/mobile && npm ci && npx tsc --noEmit     # 앱 타입체크 (Expo Go 로는 못 돌린다 — 네이티브 모듈)
node tools/check-expo-versions.mjs apps/mobile   # 네이티브 의존성 건드렸으면 반드시
node tools/review-transcript.mjs data/transcripts/<파일>   # 전사본 1차 검토 → 판정표·질문
node tools/sync-skill-rules.mjs                  # 확정 규칙을 스킬 안으로 (confirmed.jsonl 을 고쳤으면 반드시)
```

앱 실행 검증은 CI 가 만든 APK 를 폰에 설치해서 한다. 이 환경에서는 안드로이드 빌드가 안 돈다.

## 스킬 — 언제 무엇을 읽나

`.claude/skills/` 에 있다. 이름을 부르지 않아도 해당 작업이면 먼저 읽는다.

**이 저장소 고유 규칙 (반드시)**
- `nsr-transcript-review` — 전사본 검토·교정·질문. 녹음본/전사 파일이 들어오면 항상. 판별 기준은 실제 세션에서 채운다 — 지어내지 않는다.
- `nsr-privacy` — 전사본·녹음·사전이 기기 밖으로 나가는 코드 전부 (LLM 호출 포함).
- `nsr-design` — 화면·컴포넌트·색·글자.
- `nsr-android-build` — APK·CI·gradle·네이티브 의존성.

**분석 파이프라인 (0.1.4x 부터. `services/pipeline.ts`·`llm.ts` 를 만지면 반드시)**
- `nursing-pipeline` — 단계 순서(전사→마스킹→추출→검증→조사→보고서·카드→대화→임상 판단)와 실패 시 중단 규칙.
- `pipeline-schema` — 각 단계 JSON 스키마 정본 (`schema.json`). 코드가 어긋나면 코드가 틀린 것.
- `provider-routing` — 경로별(Claude 단독 / GPT+Gemini 하이브리드) 모델 배정과 근거. 자동 대체 금지.
- `batch-ops` — Batch API 제출·폴링·복구 (`pipeline_jobs`).
- `korean-clinical-style` — 보고서·카드·안내문의 한국어 임상 문체.
- `openai-api`, `gemini-api` — 각 API 를 fetch 로 부르는 참조 (SDK 금지). Anthropic 은 `claude-api` 내장 스킬.

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
6. 코드 주석·문서·화면 문구는 한국어. **화면 문구는 해요체**이고 규칙은 `nsr-design`
   스킬의 "말투" 절에 있다 (버튼 8자·제목 20자·본문 35자, 느낌표·유행어·개발 용어
   금지, 오류는 원인+해결). 주석은 이 제한을 받지 않는다.
7. API 키는 `expo-secure-store` 에만. 저장소·로그·설정 DB 에 넣지 않는다.

## 사용자와 대화할 때

- 비개발자다. 용어는 풀어서 쓰고, 명령은 복사해서 붙일 수 있게 코드 블록으로.
- 판독 불가 전사는 추측해서 확정하지 말고 `nsr-transcript-review` 의 질문 형식으로 묻는다 (파일명·시각·문장).
- 환자 실명·등록번호는 답변에 옮기지 않는다. 환자A·환자B 로 부른다.
