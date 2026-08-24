#!/usr/bin/env bash
# 릴리스 노트("이번 판에서 바뀐 것")를 만든다.
#
# APK 만 올려 두면 받는 사람은 판 번호만 보고 설치할지를 정해야 한다.
# 지난 판(v* 태그) 이후의 커밋 제목을 그대로 쓰고, 자세한 설명은 접어 둔다.
# 커밋 제목이 곧 릴리스 노트다. 그래서 제목은 사람이 읽을 한 줄로 쓴다.
#
# 사용: tools/release_notes.sh [지난판태그]   (안 주면 스스로 찾는다)
#   GitHub Actions 밖에서도 돌아간다 (링크 줄만 빠진다).
set -euo pipefail

PREV="${1-}"
if [ -z "$PREV" ]; then
  # HEAD 에서 닿는 가장 가까운 v* 태그. 첫 릴리스면 비어 있다.
  PREV="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
fi

if [ -n "$PREV" ]; then
  RANGE="$PREV..HEAD"
else
  RANGE="HEAD"
fi

# 한 판에 스무 개 넘게 들어가는 일은 드물다. 그래도 상한을 둔다 —
# 태그를 한참 안 달았을 때 릴리스 본문이 수천 줄이 되는 것을 막는다.
MAX=20

SUBJECTS="$(git log --no-merges --pretty=format:'- %s' -n "$MAX" $RANGE || true)"
COUNT="$(git log --no-merges --oneline -n 200 $RANGE | wc -l | tr -d ' ')"

cat <<'HEADER'
> **알파 판입니다.** 기능이 자주 바뀌고, 저장 형식도 바뀔 수 있습니다.
> 중요한 녹음은 이 앱에만 두지 마세요.

HEADER

echo "## 이번 판에서 바뀐 것"
echo
if [ -z "$SUBJECTS" ]; then
  echo "- 바뀐 내용 없음 (같은 코드로 다시 빌드한 판입니다)"
else
  echo "$SUBJECTS"
  if [ "$COUNT" -gt "$MAX" ]; then
    echo "- … 그 밖에 $((COUNT - MAX)) 건"
  fi
fi
echo

# 자세한 설명. 커밋 본문에 "왜 그렇게 했는지" 가 들어 있다. 길어서 접어 둔다.
BODIES="$(git log --no-merges --pretty=format:'### %s%n%n%b' -n "$MAX" $RANGE || true)"
if [ -n "$BODIES" ]; then
  echo "<details><summary>자세한 설명</summary>"
  echo
  # 꼬리표는 읽는 사람에게 쓸모가 없다.
  echo "$BODIES" | grep -v -E '^(Co-Authored-By|Claude-Session):' || true
  echo
  echo "</details>"
  echo
fi

if [ -n "$PREV" ] && [ -n "${GITHUB_REPOSITORY-}" ] && [ -n "${VERSION_NAME-}" ]; then
  echo "지난 판과의 차이: https://github.com/$GITHUB_REPOSITORY/compare/$PREV...v$VERSION_NAME"
  echo
fi

cat <<'FOOTER'
---

## 설치

폰에서 아래 `.apk` 를 눌러 받은 뒤 열면 설치됩니다.
**기존 앱 위에 덮어 설치**하면 녹음·전사본·학습카드가 그대로 남습니다. 지우지 마세요.

처음 설치할 때 "출처를 알 수 없는 앱" 허용을 한 번 물어봅니다.

## 처음 켜면 할 일

1. 최초 고지를 읽고 넘어갑니다 (법적 사항이 들어 있습니다)
2. **설정 → 전사 모델**에서 모델을 하나 받습니다. 이걸 안 하면 전사가 안 됩니다.
   Wi-Fi 에서 받으세요 — 작은 것도 180MB 입니다.
3. 듀티표를 넣으면 근무 시간에 자동으로 녹음합니다

## 알파에서 아직 안 되는 것

- **화자 자동 구분** — 기기 안에서 도는 Whisper 는 목소리를 구별하지 못합니다.
  전사 탭에서 구간을 직접 지정하셔야 근무 환경 지표가 나옵니다.
- **iOS** — 이 판은 안드로이드만 있습니다.
FOOTER

echo
echo "커밋: ${GITHUB_SHA-$(git rev-parse HEAD)}"
