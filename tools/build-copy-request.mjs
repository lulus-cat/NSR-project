import fs from "node:fs";
const ROOT = "/home/user/NSR-project";
const P = `${ROOT}/docs`;
const items = JSON.parse(fs.readFileSync(`${P}/ui-strings.json`, "utf8"));

const SCREENS = {
  "apps/mobile/app/(tabs)/index.tsx": "홈 (출근 전 브리핑)",
  "apps/mobile/app/(tabs)/duty.tsx": "듀티표 (월 달력)",
  "apps/mobile/app/(tabs)/care.tsx": "채팅 (마음 돌봄 + 학습 대화)",
  "apps/mobile/app/notes.tsx": "노트 목록",
  "apps/mobile/app/note/[id].tsx": "노트 편집기",
  "apps/mobile/app/(tabs)/study.tsx": "학습 (암기카드 복습)",
  "apps/mobile/app/(tabs)/glossary.tsx": "용어 (간호 용어·은어 사전)",
  "apps/mobile/app/(tabs)/settings.tsx": "설정",
  "apps/mobile/app/(tabs)/_layout.tsx": "아래 탭 이름",
  "apps/mobile/app/onboarding.tsx": "첫 실행 고지·동의",
  "apps/mobile/app/models.tsx": "전사 모델 받기",
  "apps/mobile/app/ward-dict.tsx": "병동 사전 (우리 병동 말)",
  "apps/mobile/app/shift/[id].tsx": "근무 하나의 기록·전사본",
  "apps/mobile/app/_layout.tsx": "앱 전체 골격",
};
const label = (w) => {
  const f = w.split(":")[0];
  if (SCREENS[f]) return SCREENS[f];
  if (f.startsWith("apps/mobile/src/components")) return "공용 UI 부품";
  if (f.startsWith("apps/mobile/src/services")) return "동작 중 안내·오류 메시지";
  if (f.includes("taeum")) return "태움 지표(체온) 설명";
  if (f.includes("duty")) return "근무 코드·근로시간 경고";
  if (f.includes("models")) return "전사 모델 안내";
  if (f.includes("study")) return "근무 보고서";
  if (f.includes("release")) return "업데이트 안내";
  return f;
};

const SHORT = 7;
const short = items.filter((r) => r.text.length <= SHORT);
const long = items.filter((r) => r.text.length > SHORT);

// 화면별로 묶어야 제미나이가 맥락을 안다.
const groups = new Map();
for (const r of long) {
  const g = label(r.where[0]);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}

const HEAD = `# NSR 앱 한글 UI 문구 다듬기

## 이 앱이 무엇인가
한국 병원의 **신규 간호사**가 쓰는 개인 업무 도구입니다. 근무(인계·교육)를 녹음해
글로 옮기고, 거기서 용어 암기카드를 만들고, 근무 환경(괴롭힘 정황)을 기록으로 남깁니다.
새벽 3시 스테이션에서, 피곤한 눈으로, 한 손으로 쓰는 화면입니다.

## 당신이 할 일
아래 문구들이 **번역체 같고, 읽기 어렵고, 화면에서 예뻐 보이지 않습니다.**
자연스러운 한국어로 다시 써 주세요.

## 다시 쓸 때의 기준
1. **번역투를 없앤다.** "~하는 것이 가능합니다" → "~할 수 있습니다".
   "~에 대해", "~를 통해", "~에 있어서" 같은 번역 냄새나는 표현을 걷어냅니다.
2. **짧게.** 화면은 좁습니다. 같은 뜻이면 무조건 짧은 쪽입니다.
   지금보다 길어지면 안 됩니다. 두 문장으로 할 말은 한 문장으로.
3. **말투는 '합니다체'로 통일.** 해요체(~해요), 반말, 명사형 종결(~함)을 쓰지 않습니다.
4. **간호사에게 말하듯.** 설명충처럼 굴지 말고, 동료가 알려주듯 담백하게.
   과장("완벽하게", "혁신적인")과 사과("죄송하지만")를 넣지 않습니다.
5. **읽는 리듬.** 한 문장이 40자를 넘으면 끊는 것을 검토합니다.
   쉼표를 남발하지 말고, 중요한 말을 문장 앞에 둡니다.

## 절대 바꾸면 안 되는 것
- **\`\${...}\` 안의 내용** — 프로그램이 값을 채워 넣는 자리입니다. 통째로 그대로 두세요.
  (예: \`남은 \${queue.length}장\` 에서 \`\${queue.length}\` 는 손대지 않음)
- **\`&ldquo;\` \`&rdquo;\` 같은 기호** — 그대로 둡니다.
- **전문 용어·고유명사**: 태움, 인계, 듀티, 데이/이브닝/나이트, 상근, 스페셜, 오프,
  폴리, 전사, 비식별화, 통신비밀보호법, 근로기준법, whisper, ggml, API 키, OAuth 등.
  뜻을 풀어 쓰지 말고 그대로 두세요. 간호사는 이 말들을 이미 압니다.
- **사실관계와 숫자.** 없는 기능을 있다고 쓰거나, 못 하는 것을 할 수 있다고 쓰면 안 됩니다.
  이 앱의 신뢰는 "안 되는 것을 안 된다고 말하는 것"에서 옵니다.
  법률·기술적 한계를 설명하는 문장은 **뜻을 절대 바꾸지 말고 표현만** 다듬으세요.

## 답변 형식 (반드시 지켜 주세요)
바꾼 것만, 한 줄에 하나씩, 아래 형식으로만 출력하세요. 설명·머리말·표를 붙이지 마세요.

\`\`\`
[T001] 새로 쓴 문장
[T014] 새로 쓴 문장
\`\`\`

- 지금 그대로 두는 게 낫다고 판단한 항목은 **아예 출력하지 마세요.**
- 줄바꿈 없이 한 줄로 씁니다.
- 답변이 길어 잘리면, 마지막에 어디까지 했는지 적어 주세요. 이어서 요청하겠습니다.

---
`;

let body = "";
let n = 0;
for (const [g, rows] of groups) {
  body += `\n## ${g}\n\n`;
  for (const r of rows) { body += `[${r.id}] ${r.text}\n`; n++; }
}

body += `\n## 짧은 라벨 (버튼·탭·배지)\n\n`;
body += `이 항목들은 **길이를 늘리면 화면에서 잘립니다.** 지금 글자 수 이하로만 고치고,\n`;
body += `어색하지 않으면 그대로 두세요.\n\n`;
for (const r of short) body += `[${r.id}] ${r.text}\n`;

fs.writeFileSync(`${P}/06-ui-copy-request.md`, HEAD + body);
console.log(`문장 ${n}개 + 짧은 라벨 ${short.length}개 = ${items.length}개`);
console.log(`파일 ${(HEAD + body).length}자`);
