#!/usr/bin/env bash
# prebuild 가 만들어 놓은 android/ 를 빌드 직전에 손본다.
#
# 왜 필요한가
# ----------
# `expo prebuild` 는 android/ 폴더를 통째로 새로 만든다. 그래서 저장소에
# 커밋해 둘 수가 없고, 고칠 것이 있으면 **만들어진 다음에** 고쳐야 한다.
# 이 스크립트가 그 자리다. CI 와 각자 컴퓨터에서 똑같이 돌아간다.
#
# 사용: tools/prepare-android-build.sh <android 폴더>
set -euo pipefail

ANDROID_DIR="${1:-apps/mobile/android}"

# ── 1. Gradle 래퍼는 건드리지 않는다 ──────────────────────────────────
#
# 한때 여기서 래퍼 판을 9.3.1 → 9.4.1 로 올렸다. **그게 틀렸다.**
#
# 처음 본 오류는 이거였다.
#   Minimum supported Gradle version is 9.4.1. Current version is 9.3.1.
# 그래서 래퍼를 올렸더니 다음 오류가 나왔다.
#   kotlin-stdlib-2.3.0.jar ... 메타데이터 2.3.0 인데 컴파일러 2.1.0 은 2.2.0 까지만 읽음
#
# 두 오류는 같은 원인의 앞뒤였다. **react-native 판이 Expo 가 기대하는 것과 달랐다.**
#   RN 0.87.0 → AGP 9.2.1 → Gradle 9.4.1 이상 요구
#   Expo SDK 57 → Gradle 9.3.1 을 깔아 줌 (RN 0.86.2 기준으로 맞춰져 있음)
#   Gradle 9.4.1 → Kotlin stdlib 2.3.0 을 싣는데 Expo 자체 플러그인이 그걸 못 읽음
#
# 래퍼를 올리는 것은 증상만 옮기는 일이었다. RN 을 Expo 가 기대하는 0.86.2 로
# 맞추니 AGP 가 8.12.0 이 되고, 9.3.1 로 충분해졌다.
#
# 그래서 여기서는 **아무것도 안 한다.** prebuild 가 깔아 준 판을 그대로 쓴다.
# 앞으로 또 판이 안 맞으면 래퍼를 손대지 말고 package.json 을 맞출 것.

# ── 2. 메모리 ────────────────────────────────────────────────────────
#
# React Native 새 아키텍처는 빌드할 때 코드 생성을 많이 한다. 기본값(2GB)으로도
# 대개 되지만 안 될 때 나오는 오류가 "Java heap space" 라 원인을 알아보기 어렵다.
# 넉넉히 잡아 둔다. 러너에는 16GB 가 있다.
PROPS="$ANDROID_DIR/gradle.properties"
if ! grep -q '^# NSR' "$PROPS" 2>/dev/null; then
  {
    echo ""
    echo "# NSR — tools/prepare-android-build.sh 가 넣은 값"
    echo "org.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8"
  } >> "$PROPS"
  echo "gradle 메모리 6GB 로 올렸습니다."
fi

echo "안드로이드 빌드 준비 끝."
