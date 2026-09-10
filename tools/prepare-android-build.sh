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

# ── 2. CPU 종류를 하나로 줄인다 ──────────────────────────────────────
#
# 기본값은 네 가지를 다 만든다.
#   armeabi-v7a, arm64-v8a, x86, x86_64
#
# 그런데 이건 **같은 C++ 을 네 번 컴파일하고 네 벌을 디스크에 쌓는다는 뜻**이다.
# 러너의 디스크가 그걸 못 버텨서 마지막 링크 단계에서 이렇게 죽었다.
#
#   clang++: error: unable to execute command: Bus error (core dumped)
#
# Bus error 는 링커가 mmap 한 파일을 늘리지 못할 때 나온다. 즉 디스크가 찼다는
# 뜻이지 코드가 잘못됐다는 뜻이 아니다. 62개 컴파일이 전부 끝나고 마지막
# 링크에서만 죽은 것이 그 증거다.
#
# arm64-v8a 하나면 2015년 이후 안드로이드 폰은 사실상 전부 돌아간다.
# x86 계열은 에뮬레이터용이라 실물 폰에 넣을 알파에는 필요 없다.
# 시간도 디스크도 넷에서 하나로 줄어든다.
ABI="arm64-v8a"
PROPS="$ANDROID_DIR/gradle.properties"

if grep -q '^reactNativeArchitectures=' "$PROPS"; then
  BEFORE="$(sed -n 's/^reactNativeArchitectures=//p' "$PROPS")"
  sed -i.bak "s/^reactNativeArchitectures=.*/reactNativeArchitectures=$ABI/" "$PROPS"
  rm -f "$PROPS.bak"
  echo "CPU 종류: $BEFORE → $ABI"
else
  echo "reactNativeArchitectures=$ABI" >> "$PROPS"
  echo "CPU 종류: $ABI 로 지정"
fi

# ── 3. 메모리 ────────────────────────────────────────────────────────
#
# 한때 6GB 로 잡았다. 과했다 — 링크가 죽은 건 메모리가 아니라 디스크 문제였고,
# 러너 메모리를 JVM 이 크게 물고 있으면 clang 이 쓸 몫이 줄어든다.
# 새 아키텍처 코드 생성에 기본값(2GB)은 빠듯하니 4GB 로 둔다.
if grep -q '^org\.gradle\.jvmargs=' "$PROPS"; then
  sed -i.bak 's/^org\.gradle\.jvmargs=.*/org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8/' "$PROPS"
  rm -f "$PROPS.bak"
fi
echo "gradle 메모리: $(sed -n 's/^org\.gradle\.jvmargs=//p' "$PROPS")"

# ── 4. 서명 ──────────────────────────────────────────────────────────
#
# 왜 필요한가
# ----------
# 지금까지는 안드로이드가 만들어 주는 **디버그 열쇠**로 서명했다. 혼자 쓸 때는
# 그걸로 충분했다. 남에게 나눠 주기 시작하면 아니다 — 디버그 열쇠는 모두의
# 컴퓨터에 똑같이 들어 있어서, **누구나 "NSR" 인 척하는 APK 를 만들어**
# 배포할 수 있고 폰은 그걸 같은 앱의 새 판으로 받아들인다.
#
# 그리고 열쇠가 바뀌면 안드로이드는 업데이트를 거부한다. 지금 디버그 열쇠로
# 퍼뜨린 뒤에 제대로 된 열쇠로 바꾸면, 받은 사람은 전부 **지우고 다시 깔아야**
# 한다(그때 앱 안의 녹음과 전사본이 같이 사라진다). 그래서 공개 전에 바꾼다.
#
# 열쇠는 저장소에 없다. NSR_KEYSTORE_BASE64 로 들어온다(GitHub Actions 비밀).
# 없으면 예전처럼 디버그 서명으로 만든다 — 남의 포크에서도 빌드는 돌아야 한다.
GRADLE="$ANDROID_DIR/app/build.gradle"

if [ -n "${NSR_KEYSTORE_BASE64:-}" ]; then
  KEYSTORE="$ANDROID_DIR/app/nsr-release.keystore"
  printf '%s' "$NSR_KEYSTORE_BASE64" | base64 -d > "$KEYSTORE"

  # 비밀번호는 gradle.properties 로 넘긴다. 명령줄 인자로 주면 `ps` 에 보인다.
  # 이 파일은 prebuild 산출물이라 커밋되지 않는다.
  sed -i.bak '/^NSR_STORE_FILE=/d;/^NSR_STORE_PASSWORD=/d;/^NSR_KEY_ALIAS=/d;/^NSR_KEY_PASSWORD=/d' "$PROPS"
  rm -f "$PROPS.bak"
  {
    echo "NSR_STORE_FILE=nsr-release.keystore"
    echo "NSR_STORE_PASSWORD=${NSR_KEYSTORE_PASSWORD:?열쇠 비밀번호가 없습니다}"
    echo "NSR_KEY_ALIAS=${NSR_KEY_ALIAS:-nsr}"
    echo "NSR_KEY_PASSWORD=${NSR_KEY_PASSWORD:-${NSR_KEYSTORE_PASSWORD}}"
  } >> "$PROPS"

  # 이미 손본 파일이면 그냥 둔다. 두 번 돌리면 블록이 겹쳐 들어가고,
  # 그다음 실행이 "템플릿이 바뀌었다" 는 엉뚱한 말로 죽는다.
  if grep -q 'NSR_STORE_FILE' "$GRADLE"; then
    echo "서명: 이미 배포용 열쇠로 되어 있습니다."
    echo "안드로이드 빌드 준비 끝."
    exit 0
  fi

  # 템플릿의 signingConfigs 에 release 를 더한다. 앵커가 없으면 **멈춘다** —
  # 조용히 넘어가면 디버그 서명 APK 가 릴리스로 올라간다.
  if ! grep -q 'signingConfigs {' "$GRADLE"; then
    echo "build.gradle 에서 signingConfigs 를 못 찾았습니다. 템플릿이 바뀌었습니다." >&2
    exit 1
  fi
  python3 - "$GRADLE" <<'PYEOF'
import re, sys

path = sys.argv[1]
body = open(path, encoding="utf-8").read()

block = """    signingConfigs {
        release {
            storeFile file(NSR_STORE_FILE)
            storePassword NSR_STORE_PASSWORD
            keyAlias NSR_KEY_ALIAS
            keyPassword NSR_KEY_PASSWORD
        }
"""
body, n = re.subn(r"    signingConfigs \{\n", block, body, count=1)
if n != 1:
    sys.exit("signingConfigs 블록을 못 열었습니다.")

# buildTypes.release 안의 debug 서명을 release 로 바꾼다. 다른 곳의
# signingConfigs.debug(=buildTypes.debug)는 그대로 둔다.
head = body.index("buildTypes {")
tail = body.index("release {", head)
before, after = body[:tail], body[tail:]
after, n = re.subn(r"signingConfig signingConfigs\.debug", "signingConfig signingConfigs.release", after, count=1)
if n != 1:
    sys.exit("buildTypes.release 의 서명 줄을 못 찾았습니다.")
open(path, "w", encoding="utf-8").write(before + after)
print("서명: 배포용 열쇠로 바꿨습니다.")
PYEOF
else
  echo "서명: 배포용 열쇠가 없어 디버그 서명으로 만듭니다 (나눠 주지 마십시오)."
fi

echo "안드로이드 빌드 준비 끝."
