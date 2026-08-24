---
name: nsr-android-build
description: NSR 의 안드로이드 APK 빌드·CI·릴리스가 깨졌을 때, 네이티브 의존성을 추가할 때, expo prebuild 나 gradle 을 건드릴 때 반드시 먼저 읽는 규칙. 여섯 번의 연속 빌드 실패에서 배운 것들이다.
---

# NSR 안드로이드 빌드 규칙

여섯 번 연속으로 빌드가 깨졌고, 그중 네 번의 뿌리가 하나였다: **판 어긋남.**

## 철칙

1. **네이티브 모듈을 추가하면 반드시 실행:**
   `node tools/check-expo-versions.mjs apps/mobile`
   Expo 가 기대하는 판(`expo/bundledNativeModules.json`)과 다르면 그 자리에서
   고친다. 어긋난 채 빌드하면 16분 뒤에 "없는 C++ 함수를 부른다" 같은
   엉뚱한 모습으로 죽는다.
2. **검증은 `npm ci` 로.** `npm install` 은 peer 충돌을 경고만 하고 넘어가지만
   CI 의 `npm ci` 는 거부한다. 로컬에서 통과했는데 CI 에서 깨지는 고전적 원인.
3. **gradle 래퍼를 올려서 문제를 넘기지 않는다.** AGP 판은 react-native 판이
   정한다. 래퍼를 올리면 증상만 옮겨간다 — 진짜 원인은 대개 RN 판이 Expo 기대와
   다른 것이다.
4. **APK 는 `assembleRelease`.** debug 는 JS 번들을 넣지 않아 폰에서
   "Unable to load script" 로 죽는다.
5. **Node 전용 모듈(node:fs 등)을 부르는 패키지를 앱에 넣지 않는다.**
   Anthropic/OpenAI SDK 가 그렇다 — API 는 fetch 로 직접 부른다 (`services/llm.ts`).
6. **android/ 는 커밋하지 않는다.** prebuild 가 매번 새로 만든다. prebuild 산출물을
   고쳐야 하면 `tools/prepare-android-build.sh` 에서 한다.
7. **릴리스는 전부 prerelease(알파).** 그래서 앱의 업데이트 확인은
   `releases/latest` 가 아니라 릴리스 목록 API 를 본다 (`releaseListUrl`) —
   latest 는 프리릴리스를 빼고 줘서 항상 404 였다.

## 빌드 시간

CI 캐시 3종이 걸려 있다: setup-node 의 npm 캐시, ~/.gradle 캐시, ccache
(NDK C++). `CMAKE_C(XX)_COMPILER_LAUNCHER=ccache` 는 잡 env 로 주입된다.
prebuild 산출물은 실행마다 바이트 단위로 동일함을 확인했다 — 캐시를 지우는
변경(의존성 추가 등)이 아니면 두 번째 빌드부터 크게 빨라야 정상이다.

## 판 번호

CI 가 태그 최고값 +1 로 `app.json` 의 version 을 새기고, versionCode 는
run_number 다. 손으로 app.json 의 version 을 올리지 않는다.
