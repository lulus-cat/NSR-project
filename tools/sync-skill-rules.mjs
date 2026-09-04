#!/usr/bin/env node
/**
 * 확정 규칙을 스킬 안으로 복사한다.
 *
 *   node tools/sync-skill-rules.mjs
 *
 * 왜 필요한가: Claude API 에 올라간 스킬은 저장소를 못 읽는다. `data/corrections/confirmed.jsonl`
 * 을 못 보므로, 확정된 것을 스킬 폴더 안 문서로 옮겨 둬야 API 쪽 Claude 도 같은 판단을 한다.
 * 손으로 두 벌 관리하면 반드시 어긋나므로 이 스크립트로만 만든다.
 */
import fs from "node:fs";

const SRC = "data/corrections/confirmed.jsonl";
const OUT = ".claude/skills/nsr-transcript-review/references/confirmed-rules.md";

const rows = fs
  .readFileSync(SRC, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const rules = rows.filter((r) => r.from && r.to);
const notes = rows.filter((r) => !r.from || !r.to).map((r) => r.note).filter(Boolean);

// 같은 결과로 모으면 표가 절반으로 준다
const byTo = new Map();
for (const r of rules) {
  if (!byTo.has(r.to)) byTo.set(r.to, { froms: [], note: "" });
  const e = byTo.get(r.to);
  if (!e.froms.includes(r.from)) e.froms.push(r.from);
  if (!e.note && r.note) e.note = r.note.replace(/\s*·?\s*20\d\d-\d\d-\d\d 확정\s*$/, "");
}

const lines = [
  "# 확정 규칙 — 사용자가 실제로 확인해 준 것만",
  "",
  "`data/corrections/confirmed.jsonl` 에서 만든다. **직접 고치지 않는다** —",
  "`node tools/sync-skill-rules.mjs` 로 다시 만든다.",
  "",
  `마지막 갱신 ${new Date().toISOString().slice(0, 10)} · 규칙 ${rules.length}건 · 표제어 ${byTo.size}개`,
  "",
  "## 이렇게 적힌 것은 이렇게 읽는다",
  "",
  "| 확정 표기 | 휘스퍼가 적은 것 | 문맥 |",
  "| --- | --- | --- |",
  ...[...byTo]
    .sort((a, b) => b[1].froms.length - a[1].froms.length)
    .map(([to, e]) => `| **${to}** | ${e.froms.join(" · ")} | ${e.note || ""} |`),
  "",
  "## 규칙으로 만들지 않은 것 — 문맥으로만 판단한다",
  "",
  ...notes.map((n) => `- ${n}`),
  "",
];

fs.writeFileSync(OUT, lines.join("\n"));
console.log(`${OUT}: 표제어 ${byTo.size}개 · 규칙 ${rules.length}건 · 메모 ${notes.length}건`);
