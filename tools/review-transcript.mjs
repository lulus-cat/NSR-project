#!/usr/bin/env node
/**
 * 전사본 1차 검토 — 결정적 교정을 돌리고, 사람(또는 문맥을 읽는 모델)이 봐야 할 것을 뽑는다.
 *
 * 쓰는 법
 * ------
 *   node tools/review-transcript.mjs data/transcripts/2026-08-24_D_01.json
 *   node tools/review-transcript.mjs data/transcripts/*.srt --out data/reviews
 *   node tools/review-transcript.mjs 파일 --no-redact     # 질문 문장의 개인정보를 가리지 않음
 *   node tools/review-transcript.mjs 파일 --json           # 항목 전체를 JSON 으로도 저장
 *   node tools/review-transcript.mjs 파일 --pack 병동사전.json
 *
 * 받는 형식: 콜랩 서버의 verbose_json(.json), .srt/.vtt, 줄 단위 .txt/.md (`[hh:mm:ss]` 접두 인식).
 *
 * 나오는 것: `data/reviews/<파일>.review.md`
 *   1. 요약 (자동 적용 / 확인 필요 / 질문 개수)
 *   2. 자동 적용한 교정 표
 *   3. 확인 필요 표
 *   4. 질문 — `.claude/skills/nsr-transcript-review` 의 질문 형식 그대로. 문장은 기본으로
 *      개인정보를 가려서 넣으므로 이 부분은 그대로 붙여넣어도 된다.
 *   5. 교정본 전체 (시각 붙음) — 환자 정보가 그대로 있다. data/reviews 는 커밋되지 않는다.
 *
 * 확정된 교정(`data/corrections/confirmed.jsonl`)이 있으면 사전보다 먼저 적용한다.
 * 그래서 한 번 답한 것은 다시 묻지 않는다.
 *
 * 왜 core 를 그대로 쓰는가: 앱이 폰에서 돌리는 교정기와 **같은 코드**여야 여기서 확정한
 * 규칙이 앱에서도 같은 결과를 낸다. 검토 도구가 따로 똑똑하면 앱과 어긋난다.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

let core;
try {
  core = await import("@nsr/core");
} catch {
  console.error("@nsr/core 를 불러올 수 없습니다. 저장소 루트에서 `npm ci` (또는 `npm run build`) 를 먼저 돌리십시오.");
  process.exit(1);
}
if (typeof core.reviewTranscript !== "function") {
  console.error("core 빌드가 오래됐습니다. `npm run build` 를 돌리십시오.");
  process.exit(1);
}
const { reviewTranscript, buildLexicon, createMemory, recordCorrection, deidentify } = core;

/* ── 인자 ─────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valueFlags = new Set(["--out", "--pack", "--rules", "--max-questions"]);
const files = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]));

if (files.length === 0) {
  console.error("검토할 전사본 파일을 주십시오. 예: node tools/review-transcript.mjs data/transcripts/2026-08-24_D_01.json");
  process.exit(1);
}

const outDir = opt("--out") ?? "data/reviews";
const rulesPath = opt("--rules") ?? "data/corrections/confirmed.jsonl";
const redact = !flags.has("--no-redact");
const wantJson = flags.has("--json");
const maxQuestions = Number(opt("--max-questions") ?? 15);

/* ── 입력 파싱 ─────────────────────────────────────────────── */

function parseTime(s) {
  // "01:02:03,450" / "01:02:03.450" / "02:03.450" / "123.4"
  const t = s.trim().replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return "--:--:--";
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function parseJson(text) {
  const obj = JSON.parse(text);
  if (Array.isArray(obj.segments)) {
    return obj.segments.map((s) => ({
      startSec: Number(s.start ?? s.startSec ?? 0),
      endSec: Number(s.end ?? s.endSec ?? 0),
      text: String(s.rawText ?? s.text ?? "").trim(),
      speaker: s.speaker ?? s.speakerId,
    }));
  }
  if (Array.isArray(obj)) return parseJson(JSON.stringify({ segments: obj }));
  if (typeof obj.text === "string") return [{ startSec: 0, endSec: 0, text: obj.text.trim() }];
  throw new Error("JSON 에 segments 도 text 도 없습니다.");
}

function parseSrt(text) {
  const out = [];
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->");
    const body = lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!body) continue;
    const spk = body.match(/^([^:]{1,20}):\s+(.*)$/);
    out.push({
      startSec: parseTime(a),
      endSec: parseTime(b.split(/\s/)[0] ?? b),
      text: spk ? spk[2] : body,
      speaker: spk ? spk[1] : undefined,
    });
  }
  return out;
}

function parseLines(text) {
  const out = [];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    let line = rawLine.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
    if (!line || line.startsWith("#")) continue;
    let startSec = out.length > 0 ? out[out.length - 1].startSec : 0;
    const m = line.match(/^[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)[\])]?\s*(.*)$/);
    if (m) {
      startSec = parseTime(m[1]);
      line = m[2];
    }
    if (!line) continue;
    out.push({ startSec, endSec: startSec, text: line });
  }
  return out;
}

function loadSegments(file) {
  const text = fs.readFileSync(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return parseJson(text);
  if (ext === ".srt" || ext === ".vtt") return parseSrt(text);
  return parseLines(text);
}

/* ── 확정 규칙·사전 ─────────────────────────────────────────── */

function loadMemory() {
  if (!fs.existsSync(rulesPath)) return { memory: undefined, count: 0 };
  let memory = createMemory(1); // 사람이 확정한 규칙은 한 번이면 충분하다
  let count = 0;
  for (const line of fs.readFileSync(rulesPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rule;
    try {
      rule = JSON.parse(line);
    } catch {
      console.warn(`규칙 한 줄을 읽지 못했습니다 (건너뜀): ${line.slice(0, 60)}`);
      continue;
    }
    if (!rule.from || !rule.to || rule.kind === "A") continue; // 반복은 규칙이 되지 않는다
    memory = recordCorrection(memory, rule.from, rule.to, Date.now());
    count++;
  }
  return { memory, count };
}

function loadLexicon() {
  const packPath = opt("--pack");
  if (!packPath) return buildLexicon();
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  return buildLexicon({ packs: [pack] });
}

/* ── 보고서 ───────────────────────────────────────────────── */

const HARM = { medication: 0, emergency: 0, procedure: 1, device: 1, lab: 2, assessment: 2 };

function harmRank(item, lexicon) {
  if (item.kind === "repetition") return 9;
  const entry = item.entryId ? lexicon.get(item.entryId) : undefined;
  if (!entry) return 5;
  return HARM[entry.category] ?? 4;
}

const KIND_LABEL = {
  misheard: "사전 오인식",
  initialism: "약어 표기",
  learned: "확정 이력",
  phonetic: "발음 매칭",
  ambiguous: "뜻 갈림",
  repetition: "반복",
  "unknown-term": "유사 용어",
  "unknown-initialism": "미등록 약어",
};

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function quote(sentence) {
  return redact ? deidentify(sentence).text : sentence;
}

function table(rows) {
  const head = "| # | 시각 | 원문 | 종류 | 제안 | 근거 | 신뢰도 |\n| --- | --- | --- | --- | --- | --- | --- |";
  const body = rows
    .map(
      (r, i) =>
        `| ${i + 1} | ${r.time} | ${cell(r.surface)} | ${KIND_LABEL[r.kind]} | ${cell(r.suggestion ?? "(뜻 확정)")} | ${cell(r.reason)} | ${r.confidence.toFixed(2)} |`,
    )
    .join("\n");
  return rows.length ? `${head}\n${body}` : "_없음_";
}

function questionBlock(items, file, lexicon) {
  const lines = [];
  items.forEach((it, i) => {
    const entry = it.entryId ? lexicon.get(it.entryId) : undefined;
    const sentence = quote(it.sentence).replace(it.surface, `[?${it.surface}]`);
    const options = [];
    if (it.kind === "repetition") {
      options.push(`① "${it.suggestion}" 한 번만 (반복 환각)`, `② 실제로 그렇게 말함 (원문 유지)`);
    } else if (it.kind === "unknown-initialism") {
      options.push(`① 약어 ${it.suggestion} (병원 고유 약어면 뜻을 알려 주십시오)`, `② 다른 말 (오인식)`);
    } else {
      options.push(
        `① ${it.suggestion}${entry ? ` (사전 용어 "${entry.ko}"${entry.abbr ? ` / ${entry.abbr}` : ""}, 발음 ${it.confidence.toFixed(2)})` : ""}`,
        `② ${it.surface} 그대로 (일반어·실제 발화)`,
        `③ 다른 말`,
      );
    }
    lines.push(
      `[질문 ${i + 1}] 파일: ${path.basename(file)} · 시각: ${it.time}`,
      `문장: "${sentence}"`,
      `후보: ${options.join(" ")}`,
      `왜 못 정하나: ${it.reason}`,
      "",
    );
  });
  return lines.join("\n");
}

/* ── 실행 ─────────────────────────────────────────────────── */

const lexicon = loadLexicon();
const { memory, count: ruleCount } = loadMemory();
fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`없는 파일: ${file}`);
    continue;
  }
  const segments = loadSegments(file);
  const rows = [];
  const corrected = [];

  segments.forEach((seg, segmentIndex) => {
    if (!seg.text) return;
    const result = reviewTranscript(seg.text, { lexicon, memory });
    corrected.push({ time: fmtTime(seg.startSec), speaker: seg.speaker, text: result.text });
    for (const it of result.items) {
      rows.push({ ...it, time: fmtTime(seg.startSec), segmentIndex });
    }
  });

  const auto = rows.filter((r) => r.verdict === "auto");
  const check = rows.filter((r) => r.verdict === "check");
  const ask = rows
    .filter((r) => r.verdict === "ask")
    .sort((a, b) => harmRank(a, lexicon) - harmRank(b, lexicon) || a.segmentIndex - b.segmentIndex);

  // 같은 표기는 한 파일에서 한 번만 묻는다. 나머지는 표에 남긴다.
  const askedSurface = new Set();
  const askFirst = [];
  const askRest = [];
  for (const r of ask) {
    const key = `${r.kind}|${r.surface}`;
    if (askedSurface.has(key) || askFirst.length >= maxQuestions) askRest.push(r);
    else {
      askedSurface.add(key);
      askFirst.push(r);
    }
  }

  const base = path.basename(file);
  const md = [
    `# 전사본 검토 — ${base}`,
    "",
    `- 세그먼트 ${segments.length}개, 확정 규칙 ${ruleCount}건 적용, ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    `- 자동 적용 ${auto.length}건 · 확인 필요 ${check.length}건 · 질문 ${askFirst.length}건 (같은 표기·상한 초과로 미룬 것 ${askRest.length}건)`,
    `- 질문의 문장은 ${redact ? "개인정보를 가렸습니다 (그대로 붙여넣어도 됩니다)" : "**가리지 않았습니다** — 밖으로 내보내지 마십시오"}`,
    "",
    "판정 절차와 세 갈래(A 반복 / B 임상 어휘 부재 / C 한글 오독)의 기준은 `.claude/skills/nsr-transcript-review/SKILL.md`.",
    "",
    "## 1. 자동 적용한 교정",
    "",
    table(auto),
    "",
    "## 2. 확인 필요 (기계가 고쳤거나 뜻을 정해야 함)",
    "",
    table(check),
    "",
    "## 3. 질문 (기계는 손대지 않았음)",
    "",
    askFirst.length ? "```\n" + questionBlock(askFirst, file, lexicon) + "```" : "_없음_",
    "",
    askRest.length ? `미룬 항목:\n\n${table(askRest)}\n` : "",
    "## 4. 교정본",
    "",
    ...corrected.map((c) => `- \`${c.time}\`${c.speaker ? ` **${c.speaker}**` : ""} ${c.text}`),
    "",
  ].join("\n");

  const outPath = path.join(outDir, `${base}.review.md`);
  fs.writeFileSync(outPath, md);
  if (wantJson) {
    fs.writeFileSync(path.join(outDir, `${base}.review.json`), JSON.stringify({ file: base, rows, corrected }, null, 2));
  }

  console.log(`${base}: 자동 ${auto.length} · 확인 ${check.length} · 질문 ${askFirst.length}(+${askRest.length}) → ${outPath}`);
  if (askFirst.length) {
    console.log("");
    console.log(questionBlock(askFirst, file, lexicon));
  }
}
