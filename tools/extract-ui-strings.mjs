// TS 파서로 정확히 뽑는다. 정규식 리터럴·주석·중첩 템플릿 전부 파서가 처리한다.
import ts from "../apps/mobile/node_modules/typescript/lib/typescript.js";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/home/user/NSR-project";
const HANGUL = /[가-힣]/;

// UI 문구만. 사전 데이터·정규식 패턴·공식자료 이름·LLM 시스템프롬프트는 뺀다.
const INCLUDE = [
  "apps/mobile/app",
  "apps/mobile/src/components",
  "apps/mobile/src/services",
  "apps/mobile/src/state",
  "packages/core/src/duty",
  "packages/core/src/taeum/score.ts",
  "packages/core/src/taeum/temperature.ts",
  "packages/core/src/transcription/models.ts",
  "packages/core/src/study/report.ts",
  "packages/core/src/release",
];
const EXCLUDE_FILES = [
  "apps/mobile/src/db",              // SQL 스키마
  "apps/mobile/src/services/llm.ts", // 모델에게 주는 지시문 — 고치면 동작이 바뀐다
];

function walkFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walkFiles(p, acc);
    } else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const targets = [];
for (const inc of INCLUDE) {
  const full = path.join(ROOT, inc);
  if (!fs.existsSync(full)) continue;
  if (fs.statSync(full).isDirectory()) targets.push(...walkFiles(full));
  else targets.push(full);
}

const items = [];
const seen = new Map();

function add(rel, line, text, kind) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || !HANGUL.test(t) || t.length < 2) return;
  if (seen.has(t)) { seen.get(t).where.add(`${rel}:${line}`); return; }
  const rec = { id: "", text: t, kind, where: new Set([`${rel}:${line}`]) };
  seen.set(t, rec);
  items.push(rec);
}

for (const full of targets.sort()) {
  const rel = path.relative(ROOT, full);
  if (EXCLUDE_FILES.some((x) => rel.startsWith(x))) continue;
  const src = fs.readFileSync(full, "utf8");
  const sf = ts.createSourceFile(full, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(rel, lineOf(node), node.text, "string");
    } else if (ts.isTemplateExpression(node)) {
      // ${...} 를 그대로 살려서 넘긴다. 제미나이가 손대면 안 되는 부분이다.
      add(rel, lineOf(node), node.getText(sf).slice(1, -1), "template");
    } else if (ts.isJsxText(node)) {
      add(rel, lineOf(node), node.text, "jsx");
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

items.forEach((r, i) => { r.id = `T${String(i + 1).padStart(3, "0")}`; r.where = [...r.where]; });
const out = path.join(ROOT, "docs/ui-strings.json");
fs.writeFileSync(out, JSON.stringify(items, null, 1));
console.log(`항목 ${items.length}개 / ${items.reduce((a, r) => a + r.text.length, 0)}자`);
