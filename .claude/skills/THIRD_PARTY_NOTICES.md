# 가져온 스킬의 출처와 라이선스

`.claude/skills/` 의 일부는 외부 공개 저장소에서 그대로(또는 이름 참조만 고쳐서) 가져온 것이다.
갱신하려면 원본 저장소를 다시 받아 같은 폴더에 덮어쓴다. 아래 표가 출처다.

| 폴더 | 출처 | 판 (받은 날) | 라이선스 |
| --- | --- | --- | --- |
| `expo-overview`, `expo-router`, `expo-module`, `expo-dev-client`, `expo-upgrade` | https://github.com/expo/skills (`plugins/expo/skills/`) | main, 2026-09-02 | MIT — `LICENSE-expo-skills.txt` |
| `test-driven-development`, `systematic-debugging`, `verification-before-completion` | https://github.com/obra/superpowers (`skills/`) | main, 2026-09-02 | MIT — `LICENSE-superpowers.txt` |

바꾼 것:
- Expo 스킬의 `agents/openai.yaml` (Codex 전용 메타데이터)은 뺐다.
- superpowers 스킬 안의 `superpowers:<이름>` 참조를 이 폴더의 이름으로 고쳤다.
- `systematic-debugging` 의 연습 문제 파일(`test-*.md`, `CREATION-LOG.md`, `find-polluter.sh`)은 뺐다.

왜 플러그인 설치가 아니라 복사인가: 이 저장소는 Claude Code 웹·모바일·CLI 여러 곳에서 열린다.
저장소 안에 있어야 어느 세션이든 같은 규칙을 읽는다. 대신 자동 갱신은 안 되므로
Expo SDK 를 올릴 때 위 저장소를 한 번 다시 확인한다.

이 저장소 고유 스킬(`nsr-*`)은 저장소와 같은 라이선스(UNLICENSED, 개인용)다.
