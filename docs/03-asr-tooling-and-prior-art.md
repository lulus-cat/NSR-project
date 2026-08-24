# 전사 도구와 기존 구현체 조사

두 가지 질문에 답하는 문서다.

1. 전사는 어떤 원리로 이뤄지고, **녹음이 끝나면 바로 전사해 주는 프로그램**은 실제로 뭐가 있나
2. 깃헙에 이미 잘 만들어 둔 것 중 가져다 쓸 만한 게 있나

원리 자체는 [docs/02-transcription-pipeline.md](02-transcription-pipeline.md)에 자세히 적혀 있다.
여기는 **무엇을 실제로 쓸 것인가**에 대한 답이다.

---

## 0. 먼저: Whisper는 어디서 도는가

**폰 안에서 돕니다.** 클라우드가 아닙니다.

Whisper는 "OpenAI 서버에 접속해서 쓰는 서비스"가 아니라 **다운로드해서 내 기기에 두고
돌리는 모델**입니다. 2022년에 가중치가 통째로 공개됐고, `whisper.cpp`가 그걸 C/C++로 다시 써서
폰에서도 돌아가게 만들었습니다. 모델 파일(수십~수백 MB)을 한 번 받아 두면 그다음부터는
**비행기 모드에서도 전사가 됩니다.**

이 앱의 기본 설정이 그렇게 되어 있습니다.

```
resolveProvider()                      ← apps/mobile/src/services/asr.ts
  ├─ 설정에서 "자체 서버 전사"를 켰나?
  │    아니오 (기본값) → createOnDeviceProvider()   ← 폰 안. 네트워크 안 씀
  └─ 예 (사용자가 직접 켬)  → createSelfHostedProvider(내 서버 주소)
```

`DEFAULT_RECORDING_POLICY`와 마찬가지로 **외부로 나가는 경로는 전부 기본 꺼짐**입니다.
켜는 것은 사용자의 명시적 선택이고, 켤 때 의료법 제19조 고지가 다시 뜹니다.

| | 온디바이스 (기본값) | 자체 서버 (켜야 동작) |
| --- | --- | --- |
| 오디오가 나가나 | **안 나감** | 사용자가 지정한 서버로 |
| 인터넷 | 필요 없음 | 필요 |
| 비용 | 0 | 서버 유지비 |
| 정확도 | small/medium 기준 보통 | large 쓰면 높음 |
| 속도 | 느림 (오프 때 배치) | 빠름 |

정확도를 조금 잃더라도 환자 정보를 안 내보내는 쪽을 기본으로 골랐습니다.
[docs/01](01-legal-and-privacy.md)의 의료법·개인정보보호법 부분이 그 이유입니다.

> 참고: 앱이 부르는 것 중 **네트워크를 쓰는 건 딱 하나** — 설정에서 켰을 때의
> LLM 보조 기능(문맥 교정·근무 요약)입니다. 그것도 기본 꺼짐이고, 전송 전에
> 비식별화가 자동 적용됩니다. 음성은 그쪽으로 안 갑니다. 글자만 갑니다.

---

## 1. "구현하기 어려울텐데" — 맞다. 그래서 안 만든다

음성인식 모델을 직접 만드는 건 개인이 할 일이 아니다. 수만 시간의 라벨링된 음성과
GPU 클러스터가 필요하다.

그런데 **만들 필요가 없다.** Whisper가 2022년에 오픈소스로 풀렸고, 지금은 폰에서도 돈다.
우리가 할 일은 두 가지뿐이다.

- 이미 있는 모델을 **불러다 쓰는 것** (아래 도구들)
- 그 모델이 한국어 간호 용어에서 틀리는 걸 **후처리로 고치는 것** (이미 만들었다 — `packages/core/src/transcription/`)

어려운 건 첫 번째가 아니라 두 번째다. 그리고 두 번째는 이 저장소가 이미 해놨다.

### 배치가 맞다, 실시간이 아니라

"녹음되면 바로"를 곧이곧대로 읽으면 실시간 스트리밍 전사를 떠올리게 되는데,
이 앱에는 **그게 오히려 나쁘다.**

| | 실시간 스트리밍 | 근무 후 배치 (이 앱의 선택) |
| --- | --- | --- |
| 배터리 | 8시간 내내 추론 → 반나절 못 감 | 충전 중·오프 때 한 번에 |
| 정확도 | 문장이 끝나기 전에 뱉으므로 낮음 | 문맥 전체를 보고 디코딩 |
| 실제 필요 | 근무 중에 전사본을 볼 일이 없다 | 퇴근 후 복기할 때 필요 |
| 처리량 | 8시간분 | VAD로 무음 걷으면 **1~2시간분** |

8시간을 녹음해도 실제 발화는 그 일부다. 무음을 걷어내고 오프 때 돌리면
중급 폰에서도 감당된다. 그래서 `DEFAULT_ASR_OPTIONS.vad = true`가 기본값이다.

---

## 2. 실제로 쓸 수 있는 도구 — 세 갈래

### (A) 폰 안에서 — 기본값

| 도구 | 무엇 | 비고 |
| --- | --- | --- |
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | Whisper의 C/C++ 구현. 양자화 모델로 폰에서 돈다 | 이 계통의 사실상 표준 |
| [whisper.rn](https://github.com/mybigday/whisper.rn) | whisper.cpp의 React Native 바인딩 | 이 저장소의 `asr.ts`가 이걸 부른다 |
| [Cap-go/capacitor-audio-recorder](https://github.com/Cap-go/capacitor-audio-recorder) | Capacitor용 백그라운드 녹음 플러그인 | PeroPix와 같은 스택 |

**장점**: 무료, 오프라인, 환자 정보가 기기를 안 벗어남 — 의료법 제19조 문제가 안 생긴다.
**단점**: small/medium 양자화 기준 정확도가 서버보다 낮고 느리다.

이 앱이 기본값으로 삼은 이유는 정확도가 아니라 **환자 정보** 때문이다.

### (B) 내 서버에서

| 도구 | 무엇 |
| --- | --- |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | CTranslate2 기반. 원본 Whisper보다 4배 빠르고 VAD 내장 |
| [WhisperX](https://github.com/m-bain/whisperX) | 단어 단위 타임스탬프 + **화자분리**. 태움 판단에 필요한 "누가 말했나"가 여기서 나온다 |
| [WhisperLive](https://github.com/collabora/WhisperLive) | 거의 실시간. PCM을 밀어 넣으면 콜백으로 전사가 온다 |
| [whisper-cpp-transcription-pipeline](https://github.com/centre-for-humanities-computing/whisper-cpp-transcription-pipeline) | **폴더 감시형**. 폴더에 오디오를 떨구면 알아서 .txt를 뱉는다 |

마지막 것이 "녹음되면 바로 전사"에 가장 가까운 형태다.
집 PC에 띄워 두고 폰이 파일을 올리면, 자는 사이에 전사가 끝나 있다.

이 저장소의 `createSelfHostedProvider(endpoint)`가 이 경로다.
**상용 API로 보내는 경로는 일부러 안 만들었다.** 병동 녹음을 제3자 서버에 올리는 건
개인정보보호법상 민감정보의 제3자 제공이고, 앱이 그 길을 기본으로 열어 두면 안 된다.

### (C) 상용 한국어 STT — Whisper 기반이 아니다

한국어 정확도만 보면 이쪽이 앞선다. 그리고 **이들은 Whisper를 한국어로 학습시킨 것이 아니다.**
각자 자기 엔진을 갖고 있다.

| | 엔진 | 만든 곳 | Whisper 기반? |
| --- | --- | --- | --- |
| 네이버 클로바 스피치 | **NEST** (Neural End-to-end Speech Transcriber) | 네이버 클라우드 | 아니오 |
| 다글로 | 자체 E2E 음성인식 엔진 | 액션파워 (2016년 창업) | 아니오 |

근거가 세 가지다.

1. **시점이 안 맞는다.** Whisper 공개는 2022년 9월이다. 클로바는 2017년부터,
   액션파워는 2016년 창업 때부터 자체 엔진을 만들어 왔다. 나중에 나온 것을 기반으로 삼을 수 없다.
2. **본인들이 아니라고 한다.** 액션파워는 빅테크 API를 쓸 수 있었지만 자체 E2E 엔진 개발을
   택했다고 밝히고 있고, Whisper와 성능을 비교하는 자료를 내놓는다 — 기반으로 삼았다면 할 수 없는 비교다.
3. **구조가 다르다.** 클로바는 실시간 스트리밍 API(gRPC)를 제공한다.
   Whisper는 30초 고정 창을 통째로 인코딩하는 attention encoder-decoder라
   **원리상 스트리밍이 안 된다.** WhisperLive 같은 구현체는 창을 겹쳐가며 반복 추론해
   흉내를 낼 뿐이다. 실시간이 되는 상용 엔진은 대개 CTC나 RNN-T(transducer) 계열이다.

"Whisper에 한국어를 더 학습시킨다"는 접근 자체는 실재한다. 다만 그건 자기 엔진을 못 만드는
쪽이 택하는 길이고, 위 두 곳은 거기 해당하지 않는다.

**그래서 코드에서 갈라진다.**

`initial_prompt`는 Whisper 고유의 장치다. 디코더 앞에 텍스트를 붙여 언어모델 사전확률을
바꾸는 것이라, 다른 엔진에는 그런 입구가 없다. 대신 상용 엔진은 **키워드 부스팅**을 준다.

| | Whisper `initial_prompt` | 클로바 키워드 부스팅 |
| --- | --- | --- |
| 방식 | 디코더 앞 문맥 주입 | 단어별 인식 확률 가중 |
| 상한 | 224 토큰 (≈ 100~140 단어) | **1,000 단어** |
| 언어 | 제한 없음 | 한국어만 |
| 넣을 형태 | "브이에스" 또는 "V/S" | **"브이에스"만** |

마지막 줄이 중요하다. 한국어 오디오에 "ABGA"라는 소리는 존재하지 않는다 —
사람은 "에이비지에이"라고 발음한다. 그래서 `buildKeywordBoosting()`은
`toHangulReading()`으로 약어를 읽기형으로 바꿔 넣고, 한글이 아닌 표기는 아예 뺀다.

```ts
buildInitialPrompt(lexicon)      // Whisper 계열   — 224토큰 예산
buildHotwords(lexicon)           // faster-whisper — shallow fusion
buildKeywordBoosting(lexicon)    // 클로바 등      — 한글만, 1,000개, 가중치
```

**후처리 교정은 엔진과 무관하게 그대로 쓴다.** 어떤 엔진을 쓰든 출력은 한국어 텍스트이고,
"카데타 → 카테터", "에이비지에이 → ABGA"는 텍스트 단계의 일이다.
`AsrProvider` 인터페이스를 둔 이유가 이것이다 — 엔진을 갈아도 `packages/core`는 안 바뀐다.

다만 셋 다 오디오를 외부로 보낸다. 쓰려면 앱이 아니라 **본인 판단으로, 비식별화를 거쳐** 쓰는 게 맞다.
`deidentify()`가 그 단계를 맡는다(등록번호·전화번호·호칭 앞 이름 마스킹).
음성 자체는 비식별화할 수 없다는 점은 분명히 해둔다 — 목소리에 이름과 진단이 그대로 담긴다.

### 실제 숫자 — 그리고 그 숫자를 어디까지 믿을 것인가

**먼저 경고.** 공개된 한국어 STT 비교 글은 거의 전부 이해관계가 있는 쪽이 쓴다.
경쟁 서비스가 쓴 비교표, Whisper 기반 제품이 쓴 "Whisper가 낫다"는 글,
벤더가 자기 테스트셋으로 낸 "우리가 8~10% 앞선다"는 발표. 전부 참고는 되지만
그대로 믿을 수는 없다. 아래 숫자도 그 전제로 읽는다.

| | 한국어 CER | 출처 성격 |
| --- | --- | --- |
| Whisper large-v3 (원본) | 8~12% | 여러 벤치마크 종합 |
| Whisper small (원본) | **18.05%** | ENERZAi 실측 |
| Whisper small + 한국어 재학습 + 전용 토크나이저 | **6.45%** | 같은 테스트셋 |
| 484MB 한국어 재학습 모델 | large-v3의 **약 절반** | 같은 곳 |

마지막 두 줄이 이 프로젝트에 중요하다.

**모델을 키우는 것보다 한국어로 학습시키는 쪽이 훨씬 크게 먹힌다.**
같은 small 크기에서 18% → 6.45%다. 세 배 차이다. 3GB짜리 large-v3를 폰에 넣는 것보다
484MB짜리 한국어 재학습 모델이 더 정확하다. ENERZAi는 5만 시간, 3,800만 쌍의
한국어 데이터로 이걸 만들었다.

그래서 이 앱의 온디바이스 기본값은 **한국어 파인튜닝 모델**이다
(`DEFAULT_ON_DEVICE_MODEL`). 원본 `ggml-small`을 그대로 쓰면 CER 18%인데,
그 18%가 어디에 몰리느냐가 문제다 — 약물명과 수치에 몰리면 쓸 수 없는 시스템이 된다.

HuggingFace의 한국어 파인튜닝 모델은 whisper.cpp의 `models/convert-h5-to-ggml.py`로
ggml로 바꿔 넣을 수 있다.

> 참고로 이건 "Whisper에 한국어만 더 학습시키면 되는 것 아니냐"는 직관이
> **맞다는 증거**이기도 하다. 클로바·다글로가 그 길을 안 갔을 뿐이지,
> 그 길 자체는 매우 잘 통한다. 그리고 우리 같은 입장에서는 그게 유일하게 가능한 길이다.

### 소비자용 서비스 비교 (클로바노트 · 다글로)

API가 아니라 앱으로 쓸 때의 이야기다. 지금 다글로를 쓰고 계시다면 이 표가 맞다.

| | 클로바노트 | 다글로 |
| --- | --- | --- |
| 무료 한도 | 월 300분 (개인정보 활용 동의 시 600분) | 앱 직접 녹음은 무제한, 파일·유튜브 업로드는 월 4시간 |
| 유료 | 개인용 없음 (기업용만) | 개인 플랜 있음 |
| 강점 | 화자분리, 한국어 존댓말·격식 처리 | 문장부호로 말의 흐름을 살림, 전문용어 상대적 강세 |
| 약점 | 고유명사·외국어 이름 약함, 문장 호흡 구분 표기 없음 | — |

**8시간 근무 녹음에는 둘 다 무료 한도로 안 된다.** 하루 8시간이면 480분이다.
다글로의 "앱 직접 녹음 무제한"이 유일하게 맞는 구조인데, 그건 다글로 앱으로 녹음해야 한다는 뜻이라
이 앱의 자동 녹음과 겹친다.

### 그런데 이 표들은 우리 질문에 답하지 못한다

위 숫자는 전부 **회의·강의·인터뷰** 기준이다. 병동 인계는 다른 문제다.

- 영문 약어를 한국어로 읽는 코드스위칭이 발화의 상당 부분
- 여러 사람이 겹쳐 말하고, 알람·발소리·카트 소리가 계속 깔림
- 말이 빠르고 문장이 안 끝남
- 틀리면 안 되는 것(약물명·용량·환자 지시)이 전체의 일부에 몰려 있음

마지막 항목이 결정적이다. **전체 CER이 낮아도 그 오류가 전부 약물명이면 쓸모없다.**
그래서 이 프로젝트의 평가 지표는 CER이 아니라 용어 재현율·과교정률이다(아래).

결론: 벤치마크로 엔진을 고르지 말고, **본인 근무 녹음 30분으로 직접 재볼 것.**
같은 파일을 두세 엔진에 넣고 약물명·약어가 몇 개나 살아남는지 세면 된다.
그게 이 용도에서 유일하게 의미 있는 비교다.

### 한국어는 CER로 본다

영어권은 WER(단어 오류율)을 쓰지만 한국어는 교착어라 어절 단위 비교가 왜곡된다.
**CER(글자 오류율)**이 더 맞다. 그런데 이 앱에서 진짜 봐야 할 지표는 따로 있다 —
전체 CER이 5%여도 그 5%가 전부 약물명이면 쓸모없는 시스템이다.
그래서 `docs/02`의 평가 지표는 **용어 재현율·과교정률**을 앞에 둔다.

---

## 3. 깃헙 기존 구현체 — 가져올 것과 안 가져올 것

### 가져다 쓴다

| 영역 | 프로젝트 | 판단 |
| --- | --- | --- |
| 음성인식 | whisper.cpp / whisper.rn | **직접 만들 이유가 없다.** 어댑터만 쓴다 |
| 화자분리 | WhisperX (pyannote 계열) | 서버 전사를 쓸 때 그대로 받는다 |
| 백그라운드 녹음 | Capacitor/Expo 오디오 플러그인 | OS 제약은 어떤 라이브러리를 써도 같다 |
| 약어 사전 씨앗 | [clinical-abbreviations](https://github.com/lisavirginia/clinical-abbreviations) (Meta-Inventory, CC-BY-4.0) | 영문 약어→원말. **한국어 뜻과 발음형은 여기서 안 나온다** |
| 약어 중의성 | [MeDAL](https://github.com/McGill-NLP/medal) | 문맥에 따른 약어 판별 학습용 데이터 |

Meta-Inventory는 CC-BY-4.0이라 출처만 밝히면 쓸 수 있다. 다만 **미국 영어 기준**이고,
이 앱에 필요한 건 "한국 병동에서 그 약어를 뭐라고 소리 내어 읽는가"다.
그건 저 데이터에 없다. 그래서 한국어 쪽은 직접 만들었다.

### 안 가져온다 — 직접 만든 이유

| 영역 | 왜 |
| --- | --- |
| 한국어 음운 정규화 + 자모 가중 편집거리 | 한국어-의료-음성인식이 겹치는 지점의 공개 구현을 못 찾았다. 이게 이 저장소의 핵심이다 |
| 한글 약어 읽기 복원 ("에이비지에이"→ABGA) | 같은 이유. 영어권에는 이 문제 자체가 없다 |
| 태움 지표 | 존재하지 않는다. 만들려면 한국 병동 맥락을 아는 사람이 설계해야 한다 |
| 듀티표·근로시간 지표 | 3교대 자정 넘김, 인계 버퍼, 근로기준법 조항 연결은 국내 맥락이다 |

### 바꿔볼 만한 것 — SRS 알고리즘

지금은 **SM-2**(1987년 Anki 기본 알고리즘)를 쓴다. 단순하고 예측 가능해서 골랐다.
더 나은 것이 있다.

- [FSRS](https://github.com/open-spaced-repetition) — 기억 곡선을 세 변수(난이도·안정성·인출가능성)로 모델링한다.
  같은 복습량으로 파지율이 더 높다는 결과가 있고, 지금 Anki의 기본이다.

바꾸려면 `packages/core/src/study/srs.ts` 하나만 갈면 된다.
`ReviewState`에 변수 두 개가 늘고 `review()` 식이 바뀌는 정도다.
**지금 바꾸지 않은 이유**: 카드가 쌓이기 전에는 어느 쪽이든 차이가 없고,
SM-2는 동작을 사람이 눈으로 검증할 수 있다.

---

## 4. 스택에 대한 제안 — Expo 대신 Capacitor?

이 저장소의 앱은 **Expo(React Native)** 로 만들었다. 그런데 PeroPix는 **Capacitor**이고,
거기엔 이미 갖춰진 것이 있다.

- GitHub Actions로 `main` 푸시 → APK 빌드 → Releases 자동 첨부
- 앱 안에서 업데이트 확인 → 다운로드 → 설치 화면까지 (`www/js/updater.js`)
- `InstallerPlugin` — FileProvider + 설치 권한 처리까지 끝난 네이티브 코드
- `npm test` 하나로 도는 1,000건 이상의 단위 검사 체계

NSR을 Capacitor로 옮기면 **이 네 가지를 그대로 재사용**할 수 있다.
특히 업데이트 배포는 처음부터 만들면 꽤 번거로운 일인데, 그게 이미 돌고 있다.

| | Expo (지금) | Capacitor (PeroPix 스택) |
| --- | --- | --- |
| 배포 파이프라인 | 새로 만들어야 함 | **이미 있음** |
| 자체 업데이트 | 없음 | **이미 있음** |
| 백그라운드 녹음 | expo-audio | 플러그인 필요 (Cap-go 등) |
| 온디바이스 Whisper | whisper.rn | 네이티브 플러그인 직접 작성 필요 |
| 화면 코드 | React | HTML/JS (빌드 단계 없음) |

**갈림길은 온디바이스 Whisper다.** React Native 쪽에는 `whisper.rn`이라는 기성품이 있고,
Capacitor 쪽에는 마땅한 것이 없어 JNI 브릿지를 직접 써야 한다.

`packages/core`는 어느 쪽이든 그대로 쓴다 — 플랫폼 API를 전혀 모르기 때문이다.
바뀌는 건 `apps/mobile` 하나다.

---

## 출처

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [WhisperLive](https://github.com/collabora/WhisperLive) · [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)
- [whisper-cpp-transcription-pipeline](https://github.com/centre-for-humanities-computing/whisper-cpp-transcription-pipeline)
- [Cap-go/capacitor-audio-recorder](https://github.com/Cap-go/capacitor-audio-recorder) · [urbandroid-team/android-audio-recorder-foreground-service](https://github.com/urbandroid-team/android-audio-recorder-foreground-service)
- [clinical-abbreviations (Meta-Inventory)](https://github.com/lisavirginia/clinical-abbreviations) · [MeDAL](https://github.com/McGill-NLP/medal)
- [open-spaced-repetition (FSRS)](https://github.com/open-spaced-repetition)
- [ENERZAi — Low-bit Whisper로 한국어 음성 인식 정복하기](https://enerzai.com/resources/blog/%EC%9E%91%EC%9D%80-%EC%96%B8%EC%96%B4-%EB%AA%A8%EB%8D%B8%EC%9D%B4-%EB%A7%B5%EB%8B%A4-low-bit-whisper%EB%A1%9C-%ED%95%9C%EA%B5%AD%EC%96%B4-%EC%9D%8C%EC%84%B1-%EC%9D%B8%EC%8B%9D-%EC%A0%95%EB%B3%B5%ED%95%98%EA%B8%B0) · [whisper.cpp 모델 변환](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [네이버 클라우드 CLOVA Speech](https://www.ncloud.com/product/aiService/clovaSpeech) · [CLOVA Speech 개요(NEST)](https://guide.ncloud-docs.com/docs/clovaspeech-overview) · [실시간 스트리밍 API](https://api.ncloud-docs.com/docs/en/ai-application-service-clovaspeech-grpc)
- [액션파워 — 다글로 STT 성능 비교](https://actionpower.kr/en/article/17) · [액션파워 기술 블로그](https://actionpower.medium.com/)
