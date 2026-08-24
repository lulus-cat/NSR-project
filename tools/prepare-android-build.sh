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
WRAPPER="$ANDROID_DIR/gradle/wrapper/gradle-wrapper.properties"

# ── 1. Gradle 래퍼 판 올리기 ─────────────────────────────────────────
#
# Expo SDK 57 이 깔아 주는 래퍼는 Gradle 9.3.1 인데, 같이 딸려오는
# 안드로이드 그래들 플러그인은 9.4.1 이상을 요구한다. 짝이 안 맞아서
# 그대로 두면 build.gradle 첫 줄에서 바로 죽는다.
#
#   Failed to apply plugin 'com.android.internal.version-check'.
#   Minimum supported Gradle version is 9.4.1. Current version is 9.3.1.
#
# **내리지는 않는다.** 나중에 Expo 가 더 높은 판을 깔아 주면 그걸 그대로 쓴다.
# 여기서 무조건 9.4.1 로 고정해 버리면 그때 거꾸로 깨진다.
REQUIRED_GRADLE="9.4.1"

if [ ! -f "$WRAPPER" ]; then
  echo "gradle 래퍼 파일이 없습니다: $WRAPPER" >&2
  echo "prebuild 를 먼저 돌렸는지 확인해 주세요." >&2
  exit 1
fi

CURRENT="$(sed -n 's/.*gradle-\([0-9][0-9.]*\)-bin\.zip.*/\1/p' "$WRAPPER" | head -1)"

if [ -z "$CURRENT" ]; then
  echo "래퍼에서 gradle 판을 못 읽었습니다. 그대로 둡니다." >&2
  sed -n '/distributionUrl/p' "$WRAPPER" >&2
else
  # 두 판을 정렬해서 가장 낮은 것이 요구 판이면, 지금 것이 요구 판 이상이다.
  LOWEST="$(printf '%s\n%s\n' "$CURRENT" "$REQUIRED_GRADLE" | sort -V | head -1)"
  if [ "$LOWEST" = "$REQUIRED_GRADLE" ]; then
    echo "gradle $CURRENT — 요구 판($REQUIRED_GRADLE) 이상이라 그대로 둡니다."
  else
    echo "gradle $CURRENT → $REQUIRED_GRADLE 로 올립니다."
    sed -i.bak "s/gradle-${CURRENT}-bin\.zip/gradle-${REQUIRED_GRADLE}-bin.zip/" "$WRAPPER"
    rm -f "$WRAPPER.bak"
    sed -n '/distributionUrl/p' "$WRAPPER"
  fi
fi

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
