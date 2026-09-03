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

/**
 * 줄 단위 텍스트. 세 모양을 받는다.
 *   - NSR 앱 내보내기: `[시:분:초] 화자 | 문장` 그리고 앱이 고친 문장 다음 줄의 `  (원문) ...`
 *     → 검토는 **원문(ASR 그대로)** 으로 하고, 앱이 고친 문장은 `appText` 로 따로 든다.
 *       앱의 자동 교정 자체가 틀렸을 수 있어서다 ("아니고" → "아이고" 같은 사고).
 *   - `[hh:mm:ss] 문장` / `hh:mm:ss 문장`
 *   - 시각 없는 줄 (직전 시각을 물려받는다)
 * 시각이 1분 넘게 되돌아가면 파일 안의 다음 녹음(다른 날·다른 근무)으로 본다 → `part`.
 */
function parseLines(text) {
  const out = [];
  let part = 1;
  // 클로바노트 내보내기: `참석자 N / mm:ss` 머리줄 뒤에 문장이 줄마다 온다. 머리줄의 화자·시각을
  // 다음 머리줄까지 물려준다.
  let clovaSpeaker;
  let clovaSec;
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const orig = rawLine.match(/^\s+\(원문\)\s*(.*)$/);
    if (orig && out.length > 0) {
      const prev = out[out.length - 1];
      prev.appText = prev.text;
      prev.text = orig[1].trim();
      continue;
    }
    let line = rawLine.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
    if (!line || line.startsWith("#")) continue;
    const clova = line.match(/^(참석자\s*\d+)\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (clova) {
      const t = parseTime(clova[2]);
      if (out.length > 0 && t < out[out.length - 1].startSec - 60) part++;
      clovaSpeaker = clova[1].replace(/\s+/g, " ");
      clovaSec = t;
      continue;
    }
    let startSec = clovaSec ?? (out.length > 0 ? out[out.length - 1].startSec : 0);
    let speaker = clovaSpeaker;
    const m = line.match(/^[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)[\])]?\s*(.*)$/);
    if (m) {
      const t = parseTime(m[1]);
      if (out.length > 0 && t < startSec - 60) part++;
      startSec = t;
      line = m[2];
    }
    const spk = line.match(/^([^|]{1,20})\s*\|\s*(.*)$/);
    if (spk) {
      speaker = spk[1].trim();
      line = spk[2];
    }
    if (!line) continue;
    out.push({ startSec, endSec: startSec, text: line, speaker, part });
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
  const appEdits = [];
  const parts = new Set(segments.map((s) => s.part ?? 1));
  // 파일 안에 녹음이 여럿이면 시각 앞에 "n번째" 를 붙여 어느 녹음인지 알린다.
  const label = (seg) =>
    parts.size > 1 ? `${seg.part ?? 1}번째 ${fmtTime(seg.startSec)}` : fmtTime(seg.startSec);

  segments.forEach((seg, segmentIndex) => {
    if (!seg.text) return;
    const result = reviewTranscript(seg.text, { lexicon, memory });
    corrected.push({ time: label(seg), speaker: seg.speaker, text: result.text });
    for (const it of result.items) {
      rows.push({ ...it, time: label(seg), segmentIndex });
    }
    if (seg.appText && seg.appText !== seg.text) {
      appEdits.push({ time: label(seg), raw: seg.text, app: seg.appText, mine: result.text });
    }
  });

  // 같은 표기가 몇 번 나왔나. 긴 파일에서는 이 표가 검토의 출발점이다.
  const freq = new Map();
  for (const r of rows) {
    if (r.verdict === "auto") continue;
    const key = `${r.kind}|${r.surface}|${r.suggestion ?? ""}`;
    const f = freq.get(key) ?? { ...r, count: 0, times: [] };
    f.count++;
    if (f.times.length < 3) f.times.push(r.time);
    freq.set(key, f);
  }
  const freqRows = [...freq.values()].sort(
    (a, b) => b.count - a.count || harmRank(a, lexicon) - harmRank(b, lexicon),
  );
  const countOf = (r) => freq.get(`${r.kind}|${r.surface}|${r.suggestion ?? ""}`)?.count ?? 1;

  const auto = rows.filter((r) => r.verdict === "auto");
  const check = rows.filter((r) => r.verdict === "check");
  const ask = rows
    .filter((r) => r.verdict === "ask")
    .sort(
      (a, b) =>
        harmRank(a, lexicon) - harmRank(b, lexicon) ||
        countOf(b) - countOf(a) ||
        a.segmentIndex - b.segmentIndex,
    );

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
    parts.size > 1 ? `- 파일 안에 녹음 ${parts.size}개 (시각이 되돌아가는 지점 기준). 시각 앞의 "n번째" 가 그 순번.` : "",
    "",
    "## 0. 후보 빈도 (확인·질문 표기가 몇 번 나왔나)",
    "",
    freqRows.length
      ? "| 횟수 | 원문 | 종류 | 제안 | 예 (시각) |\n| --- | --- | --- | --- | --- |\n" +
        freqRows
          .slice(0, 80)
          .map((r) => {
            // 반복 구간은 통째로 보여주면 표가 무너진다. 단위와 횟수만.
            const shown =
              r.kind === "repetition"
                ? `"${r.suggestion}" ×${r.reason.match(/(\d+)회/)?.[1] ?? "?"}`
                : cell(r.surface);
            return `| ${r.count} | ${shown} | ${KIND_LABEL[r.kind]} | ${cell(r.kind === "repetition" ? "한 번으로" : (r.suggestion ?? "(뜻 확정)"))} | ${r.times.join(", ")} |`;
          })
          .join("\n")
      : "_없음_",
    "",
    appEdits.length
      ? [
          "## 0-1. 앱이 이미 고친 문장 (원문과 다름 — 앱의 교정이 맞는지도 본다)",
          "",
          "| 시각 | 원문(ASR) | 앱 교정 | 이 도구의 교정 |",
          "| --- | --- | --- | --- |",
          ...appEdits.slice(0, 200).map((e) => `| ${e.time} | ${cell(quote(e.raw))} | ${cell(quote(e.app))} | ${cell(quote(e.mine))} |`),
          appEdits.length > 200 ? `\n… 그 밖에 ${appEdits.length - 200}건` : "",
          "",
        ].join("\n")
      : "",
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
