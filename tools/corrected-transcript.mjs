#!/usr/bin/env node
/**
 * 교정 전사본 만들기 — 사람이 읽고 확인할 판.
 *
 *   node tools/corrected-transcript.mjs data/transcripts/<파일> [--out data/reviews] [--keep-duplicates]
 *
 * 앱 내보내기(`[시:분:초] 화자 | 문장`, `(원문)` 줄)를 읽어 세 층으로 표시한다.
 *   1. 확정된 교정 — 사전(misheard)과 data/corrections/confirmed.jsonl 을 적용해 **본문을 바꾼다.**
 *      바뀐 문장은 아래에 "  (원문) …" 를 남긴다. 원문은 언제나 남는다.
 *   2. 제안 — data/corrections/proposed.jsonl (Claude 판정, 미확정). 본문은 안 바꾸고
 *      그 말 바로 뒤에 ⟨→ 제안?⟩ 을 붙인다. 사용자가 보고 확정하면 confirmed 로 옮긴다.
 *   3. 미해결 — data/corrections/open.txt 에 적힌 말은 [?말] 로 표시한다.
 * 반복 환각(같은 말 3회 이상 연속)은 한 번으로 접고 "(×n 반복 접음)" 을 붙인다.
 * 파일 안에 같은 녹음이 두 번 들어 있으면(바이트 단위 동일) 뒤의 것을 뺀다.
 *
 * 출력은 data/reviews/ (커밋되지 않음 — 환자 정보가 있다).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const core = await import("@nsr/core").catch(() => null);
if (!core) {
  console.error("@nsr/core 를 불러올 수 없습니다. 저장소 루트에서 `npm ci` 또는 `npm run build` 를 먼저 돌리십시오.");
  process.exit(1);
}
const { reviewTranscript, buildLexicon, createMemory, recordCorrection, findRepetitions } = core;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (files.length === 0) {
  console.error("파일을 주십시오. 예: node tools/corrected-transcript.mjs data/transcripts/2026-09-02_duty_export.txt");
  process.exit(1);
}
const outDir = opt("--out") ?? "data/reviews";
const keepDup = args.includes("--keep-duplicates");

/* ── 규칙 읽기 ─────────────────────────────────────────── */

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

let memory = createMemory(1);
let confirmedCount = 0;
for (const r of readJsonl("data/corrections/confirmed.jsonl")) {
  if (!r.from || !r.to || r.kind === "A") continue;
  memory = recordCorrection(memory, r.from, r.to, Date.now());
  confirmedCount++;
}
const proposals = readJsonl("data/corrections/proposed.jsonl").filter((r) => r.from && r.to);
// 긴 것부터 — "신전 도서" 가 "신전" 보다 먼저 잡혀야 한다.
proposals.sort((a, b) => b.from.length - a.from.length);
const openWords = fs.existsSync("data/corrections/open.txt")
  ? fs.readFileSync("data/corrections/open.txt", "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];
openWords.sort((a, b) => b.length - a.length);

const lexicon = buildLexicon();

/* ── 입력 ─────────────────────────────────────────────── */

function parseExport(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out = [];
  let prev = -1;
  let part = 1;
  // 클로바노트 내보내기(`참석자 N / mm:ss` 머리줄 + 문장 줄들)도 읽는다.
  let clova = null;
  const pad = (n) => String(n).padStart(2, "0");
  for (const line of lines) {
    const orig = line.match(/^\s+\(원문\)\s*(.*)$/);
    if (orig && out.length > 0) {
      out[out.length - 1].appText = out[out.length - 1].text;
      out[out.length - 1].text = orig[1].trim();
      continue;
    }
    const head = line.trim().match(/^(참석자\s*\d+)\s*\/\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (head) {
      const sec = head[4] === undefined ? +head[2] * 60 + +head[3] : +head[2] * 3600 + +head[3] * 60 + +head[4];
      if (prev >= 0 && sec < prev - 60) part++;
      prev = sec;
      clova = { speaker: head[1].replace(/\s+/g, " "), time: `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}` };
      continue;
    }
    const m = line.match(/^\[(\d+):(\d+):(\d+)\]\s*(?:([^|]{1,20})\s*\|\s*)?(.*)$/);
    if (!m) {
      if (clova && line.trim()) out.push({ part, time: clova.time, speaker: clova.speaker, text: line.trim() });
      continue;
    }
    clova = null;
    const sec = +m[1] * 3600 + +m[2] * 60 + +m[3];
    if (prev >= 0 && sec < prev - 60) part++;
    prev = sec;
    out.push({ part, time: `${m[1]}:${m[2]}:${m[3]}`, speaker: m[4]?.trim(), text: m[5].trim() });
  }
  return out;
}

/** 같은 녹음이 두 번 들어 있으면 뒤의 것을 뺀다. */
function dropDuplicateParts(segments) {
  const byPart = new Map();
  for (const s of segments) {
    if (!byPart.has(s.part)) byPart.set(s.part, []);
    byPart.get(s.part).push(s);
  }
  const seen = new Map();
  const dropped = [];
  for (const [part, segs] of byPart) {
    const key = segs.map((s) => `${s.time}|${s.text}`).join("\n");
    if (seen.has(key)) dropped.push({ part, sameAs: seen.get(key) });
    else seen.set(key, part);
  }
  const drop = new Set(dropped.map((d) => d.part));
  return { segments: segments.filter((s) => !drop.has(s.part)), dropped };
}

/* ── 표시 ─────────────────────────────────────────────── */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 제안·미해결 표시. 이미 표시한 자리는 다시 건드리지 않는다. */
function markSuggestions(text) {
  let out = text;
  for (const p of proposals) {
    out = out.replace(new RegExp(escapeRe(p.from) + "(?![^⟨]*⟩)", "g"), `${p.from}⟨→ ${p.to}?⟩`);
  }
  for (const w of openWords) {
    out = out.replace(new RegExp(escapeRe(w) + "(?![^⟨]*⟩)(?!\\])", "g"), `[?${w}]`);
  }
  return out;
}

/** 반복 구간을 한 번으로 접는다. */
function collapseRepeats(text) {
  const reps = findRepetitions(text);
  if (reps.length === 0) return { text, notes: [] };
  let out = "";
  let pos = 0;
  const notes = [];
  for (const r of reps) {
    out += text.slice(pos, r.start) + r.unit;
    notes.push(`"${r.unit}" ×${r.count} 반복 접음`);
    pos = r.end;
  }
  out += text.slice(pos);
  return { text: out, notes };
}

/* ── 실행 ─────────────────────────────────────────────── */

fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`없는 파일: ${file}`);
    continue;
  }
  const parsed = parseExport(fs.readFileSync(file, "utf8"));
  const { segments, dropped } = keepDup ? { segments: parsed, dropped: [] } : dropDuplicateParts(parsed);
  const parts = [...new Set(segments.map((s) => s.part))];

  let changed = 0;
  let proposed = 0;
  let collapsed = 0;
  const lines = [];
  lines.push(`# 교정 전사본 — ${path.basename(file)}`);
  lines.push(
    `# 녹음 ${parts.length}개` +
      (dropped.length ? ` (${dropped.map((d) => `${d.part}번째는 ${d.sameAs}번째와 같아 뺌`).join(", ")})` : "") +
      ` · 확정 규칙 ${confirmedCount}건 적용 · ${new Date().toISOString().slice(0, 10)}`,
  );
  lines.push("# 표기: 바뀐 문장은 아래 \"  (원문)\" 줄에 원래 문장. 말⟨→ 제안?⟩ 은 Claude 제안(미확정, 본문 안 바꿈). [?말] 은 아직 못 정한 것.");
  lines.push("");

  let currentPart = null;
  for (const seg of segments) {
    if (seg.part !== currentPart) {
      currentPart = seg.part;
      const first = segments.find((s) => s.part === seg.part);
      const last = [...segments].reverse().find((s) => s.part === seg.part);
      lines.push("", `## 녹음 ${seg.part} (${first.time} ~ ${last.time})`, "");
    }
    const collapsedRes = collapseRepeats(seg.text);
    if (collapsedRes.notes.length) collapsed++;
    const review = reviewTranscript(collapsedRes.text, { lexicon, memory });
    const corrected = review.text;
    const isChanged = corrected !== seg.text;
    if (isChanged) changed++;
    const shown = markSuggestions(corrected);
    if (shown !== corrected) proposed++;
    const spk = seg.speaker && seg.speaker !== "미확인" ? `${seg.speaker} | ` : "";
    const tail = collapsedRes.notes.length ? ` (${collapsedRes.notes.join(", ")})` : "";
    lines.push(`[${seg.time}] ${spk}${shown}${tail}`);
    if (isChanged || collapsedRes.notes.length) lines.push(`  (원문) ${seg.text}`);
  }

  const outPath = path.join(outDir, `${path.basename(file, path.extname(file))}.corrected.txt`);
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(
    `${path.basename(file)}: 문장 ${segments.length}개 · 바뀐 문장 ${changed} · 제안 표시 ${proposed} · 반복 접음 ${collapsed} → ${outPath}`,
  );
}
