#!/usr/bin/env node
/**
 * 스킬 폴더를 Claude API(Skills)에 올린다.
 *
 * 무엇을 하는가
 * ------------
 * `.claude/skills/<이름>/` 을 그대로 API 스킬로 만든다. 그러면 앱이나 다른 프로그램이
 * Messages API 를 부를 때 `container.skills` 로 이 스킬을 붙일 수 있고, 모델은
 * 저장소 없이도 SKILL.md 의 절차를 따른다. 저장소를 읽는 Claude Code 와 API 가
 * **같은 파일**을 보게 되는 것이 요점이다 — 두 벌을 따로 관리하면 반드시 어긋난다.
 *
 * 쓰는 법
 * ------
 *   ANTHROPIC_API_KEY=sk-ant-... node tools/upload-skill.mjs                      # 처음 올림
 *   ANTHROPIC_API_KEY=sk-ant-... node tools/upload-skill.mjs --update skill_01...  # 새 판
 *   node tools/upload-skill.mjs --dry-run                                         # 올라갈 파일만 확인
 *
 * 기본 대상은 nsr-transcript-review 다. 다른 폴더는 첫 인자로 준다.
 * `--save` 를 주면 결과 id 를 `<폴더>/skill-id.json` 에 적는다 (비밀 아님. 워크스페이스
 * 안에서만 뜻이 있는 식별자라 커밋해도 된다).
 *
 * 알고 쓸 것
 * ---------
 * - 키는 환경변수로만 받는다. 파일에 적지 않는다.
 * - 올라간 스킬은 그 API 키의 워크스페이스 전체에서 보인다.
 * - 새 판(version)은 전체 스냅샷이다. 빠진 파일은 사라진다. 그래서 늘 폴더째 올린다.
 * - Node 22 이상 (전역 fetch·FormData·Blob).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const API = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--update" && args[i - 1] !== "--title");

const skillDir = path.resolve(positional[0] ?? ".claude/skills/nsr-transcript-review");
const skillName = path.basename(skillDir);
const updateId = opt("--update");
const title = opt("--title");

// 올리지 않을 것: 평가 작업물, 결과 id 파일, OS 찌꺼기.
const EXCLUDE = new Set(["skill-id.json", ".DS_Store", "evals"]);

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDE.has(entry.name) || entry.name.endsWith("-workspace")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function checkFrontmatter(skillMd) {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("SKILL.md 맨 앞에 YAML 머리말(---)이 없습니다.");
  const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new Error(`name 은 소문자·숫자·하이픈 64자 이내여야 합니다: ${name}`);
  }
  if (name !== skillName) {
    throw new Error(`폴더 이름(${skillName})과 SKILL.md 의 name(${name})이 다릅니다.`);
  }
  if (!desc || desc.length > 1024) {
    throw new Error(`description 은 비어 있으면 안 되고 1024자 이내여야 합니다 (지금 ${desc?.length ?? 0}자).`);
  }
  if (/anthropic|claude/i.test(name)) {
    throw new Error("name 에 anthropic·claude 는 쓸 수 없습니다 (예약어).");
  }
  return { name, desc };
}

async function main() {
  if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
    throw new Error(`${skillDir} 에 SKILL.md 가 없습니다.`);
  }
  const files = listFiles(skillDir);
  const { name, desc } = checkFrontmatter(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
  const totalBytes = files.reduce((n, f) => n + fs.statSync(path.join(skillDir, f)).size, 0);
  if (totalBytes > 30 * 1024 * 1024) throw new Error("30MB 를 넘습니다.");

  console.log(`스킬: ${name}`);
  console.log(`설명: ${desc.slice(0, 80)}${desc.length > 80 ? "…" : ""}`);
  console.log(`파일 ${files.length}개, ${(totalBytes / 1024).toFixed(1)} KB`);
  for (const f of files) console.log(`  ${name}/${f}`);

  if (flag("--dry-run")) {
    console.log("\n--dry-run: 올리지 않았습니다.");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 없습니다. 예: ANTHROPIC_API_KEY=sk-ant-... node tools/upload-skill.mjs");
  }

  const form = new FormData();
  for (const f of files) {
    const buf = fs.readFileSync(path.join(skillDir, f));
    const type = f.endsWith(".md") ? "text/markdown" : f.endsWith(".json") ? "application/json" : "application/octet-stream";
    // 파일 이름에 폴더를 붙여야 서버가 구조를 그대로 살린다.
    form.append("files[]", new Blob([buf], { type }), `${name}/${f}`);
  }
  if (!updateId && title) form.append("display_title", title);

  const url = updateId ? `${API}/v1/skills/${updateId}/versions` : `${API}/v1/skills`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new Error("API 키가 올바르지 않습니다.");
    throw new Error(`API 오류 ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = JSON.parse(body);
  const skillId = updateId ?? data.id;
  const versionId = updateId ? data.id : data.latest_version_id;
  console.log(`\n올렸습니다.`);
  console.log(`  skill_id : ${skillId}`);
  console.log(`  version  : ${versionId}`);

  if (flag("--save")) {
    const out = path.join(skillDir, "skill-id.json");
    fs.writeFileSync(
      out,
      JSON.stringify({ skill_id: skillId, latest_version_id: versionId, uploadedAt: new Date().toISOString() }, null, 2) + "\n",
    );
    console.log(`  기록     : ${path.relative(process.cwd(), out)}`);
  }

  console.log(`
Messages API 에서 쓰는 모양 (docs/07-transcript-review-workflow.md 참고):
  "container": { "skills": [{ "type": "custom", "skill_id": "${skillId}", "version": "latest" }] },
  "tools": [{ "type": "code_execution_20250825", "name": "code_execution" }]`);
}

main().catch((e) => {
  console.error(`실패: ${e.message}`);
  process.exit(1);
});
