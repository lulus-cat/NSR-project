// 한글화 답변([Txxx] 새 문장)을 원래 자리에 되돌려 넣는다.
//
// 사용: node tools/apply-ui-copy.mjs <답변파일>
// 답변파일 형식: 한 줄에 "[T123] 새 문장" — build-copy-request.mjs 가 요청한 그대로.
//
// 원문은 docs/ui-strings.json 의 text 로 찾고, where 에 적힌 파일 안에서만
// 문자 그대로 치환한다. 원문이 이미 바뀌어 못 찾으면 건드리지 않고 보고한다 —
// 코드가 먼저 진화한 자리에 옛 답을 덮어쓰는 것보다 낫다.
import { readFileSync, writeFileSync } from "node:fs";

const answersPath = process.argv[2];
if (!answersPath) {
  console.error("사용법: node tools/apply-ui-copy.mjs <답변파일>");
  process.exit(1);
}

const decode = (s) =>
  s
    .replaceAll("&lsquo;", "‘")
    .replaceAll("&rsquo;", "’")
    .replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");

const catalog = new Map(
  JSON.parse(readFileSync("docs/ui-strings.json", "utf8")).map((e) => [e.id, e]),
);

const answers = [];
for (const line of readFileSync(answersPath, "utf8").split("\n")) {
  const m = /^\[(T\d+)\]\s+(.+)$/.exec(line.trim());
  if (m) answers.push({ id: m[1], text: decode(m[2]).trim() });
}

const fileCache = new Map();
const load = (p) => {
  if (!fileCache.has(p)) fileCache.set(p, readFileSync(p, "utf8"));
  return fileCache.get(p);
};

let applied = 0;
const skipped = [];
for (const { id, text } of answers) {
  const entry = catalog.get(id);
  if (!entry) {
    skipped.push(`${id}: 카탈로그에 없음`);
    continue;
  }
  if (entry.text === text) continue; // 바꿀 것이 없다
  const files = [...new Set(entry.where.map((w) => w.split(":")[0]))];
  let hit = false;
  for (const file of files) {
    const src = load(file);
    if (src.includes(entry.text)) {
      fileCache.set(file, src.replaceAll(entry.text, text));
      hit = true;
    }
  }
  if (hit) applied += 1;
  else skipped.push(`${id}: 원문을 찾지 못함 (코드가 먼저 바뀐 자리) — "${entry.text.slice(0, 40)}…"`);
}

for (const [p, content] of fileCache) writeFileSync(p, content);

console.log(`적용 ${applied}개 / 건너뜀 ${skipped.length}개`);
for (const s of skipped) console.log("  ·", s);
