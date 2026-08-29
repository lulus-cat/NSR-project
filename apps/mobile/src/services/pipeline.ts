/**
 * 심층 분석 파이프라인 — 3a(추출) → 3b(조사) → 4(보고서·카드).
 *
 *   3a  claude-opus-5 (effort high, 검색 없음)  Anthropic Batch
 *   3b  claude-fable-5 (웹 검색 켬)             Anthropic Batch
 *   4   gemini-3.7-flash (검색 없음)            실시간
 *
 * 왜 이 배정인가(사용자 결정, 벤치마크 근거): Opus 5 는 effort high 에서
 * 긴 문서 종합이 가장 좋고, Fable 5 는 환각률이 가장 낮아 조사 단계를 맡는다.
 * 바꾸지 말 것. 판독불가의 웹 재해석은 절대 교정목록에 병합하지 않는다 —
 * 안 들린 구간을 웹 지식으로 확정하면 그럴듯한 오답이 카드로 굳는다.
 *
 * 개인정보: 이 파일의 모든 외부 전송은 redactForNetwork 를 거친 텍스트만
 * 싣는다. 원본 오디오·마스킹 전 전사본은 여기 오지 않는다.
 *
 * 폰 앱은 언제든 죽는다: 단계·배치 id 를 DB(pipeline_jobs)에 남기고,
 * checkDeepAnalysis() 가 "지금 할 수 있는 다음 한 걸음"만 진행한다.
 * 배치 결과는 순서가 보장되지 않으므로 custom_id 로만 매칭한다.
 */
import {
  addConfirmation,
  appendPipelineUsage,
  getPipelineJob,
  listSegments,
  savePipelineJob,
  saveShiftReport,
  type PipelineJobRow,
} from "../db";
import { getDb } from "../db";
import { redactForNetwork } from "./export";
import { getApiKey } from "./llm";
import { logDebug } from "./debug";

const ANTHROPIC_API = "https://api.anthropic.com/v1";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

export type PipelineStage = "idle" | "3a" | "3b" | "4" | "done" | "error";

export interface PipelineState {
  stage: PipelineStage;
  detail: string;
  error?: string;
}

/** 이 파이프라인이 돌 수 있는 상태인가 — Claude 와 Gemini 키가 둘 다 필요하다. */
export async function pipelineReady(): Promise<{ ok: boolean; reason?: string }> {
  const [anthropic, gemini] = await Promise.all([getApiKey("anthropic"), getApiKey("gemini")]);
  if (!anthropic) {
    return {
      ok: false,
      reason:
        "심층 분석의 추출·조사 단계는 Claude 전용입니다. 설정 → 보조 기능에서 Claude API 키를 넣으면 켜집니다. 다른 모델로 대체하지 않습니다.",
    };
  }
  if (!gemini) {
    return {
      ok: false,
      reason: "보고서·카드 단계는 Gemini 가 맡습니다. 설정에서 Gemini API 키를 넣으면 켜집니다.",
    };
  }
  return { ok: true };
}

/** hh:mm:ss — 3a 가 타임스탬프를 그대로 인용할 수 있게 전사본에 붙인다. */
function ts(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 마스킹된 전사본 — 파이프라인에 들어가는 유일한 근무 원문. */
async function maskedTranscript(shiftId: string): Promise<string> {
  const segments = await listSegments(shiftId);
  const lines = segments.map(
    (s) => `[${ts(s.startSec)}]${s.speakerRole ? ` (${s.speakerRole})` : ""} ${s.text}`,
  );
  const red = await redactForNetwork(lines.join("\n"));
  return red.text;
}

/* ── Anthropic Batch REST ──────────────────────────────── */

async function anthropicHeaders(): Promise<Record<string, string>> {
  const key = await getApiKey("anthropic");
  if (!key) throw new Error("Claude API 키가 없습니다.");
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

async function submitBatch(customId: string, params: unknown): Promise<string> {
  const res = await fetch(`${ANTHROPIC_API}/messages/batches`, {
    method: "POST",
    headers: await anthropicHeaders(),
    body: JSON.stringify({ requests: [{ custom_id: customId, params }] }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("Claude API 키가 올바르지 않습니다.");
    if (detail.includes("retention")) {
      throw new Error(
        "Fable 5 는 30일 데이터 보존 설정이 필요한 모델입니다. Anthropic 콘솔의 조직 설정을 확인하십시오.",
      );
    }
    throw new Error(`배치 제출 오류 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

interface BatchResult {
  ended: boolean;
  message?: { content?: { type: string; text?: string }[]; usage?: unknown };
  error?: string;
}

/** 배치 상태를 보고, 끝났으면 custom_id 로 결과를 꺼낸다. */
async function pollBatch(batchId: string, customId: string): Promise<BatchResult> {
  const headers = await anthropicHeaders();
  const res = await fetch(`${ANTHROPIC_API}/messages/batches/${batchId}`, { headers });
  if (!res.ok) throw new Error(`배치 조회 오류 ${res.status}`);
  const data = (await res.json()) as { processing_status: string; results_url?: string };
  if (data.processing_status !== "ended") return { ended: false };
  if (!data.results_url) return { ended: true, error: "배치 결과 주소가 없습니다." };

  const results = await fetch(data.results_url, { headers });
  if (!results.ok) throw new Error(`배치 결과 다운로드 오류 ${results.status}`);
  const jsonl = await results.text();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      custom_id: string;
      result: { type: string; message?: BatchResult["message"]; error?: { message?: string } };
    };
    if (row.custom_id !== customId) continue; // 순서 비보장 — id 로만 매칭
    if (row.result.type !== "succeeded") {
      return { ended: true, error: row.result.error?.message ?? `배치 실패(${row.result.type})` };
    }
    return { ended: true, message: row.result.message };
  }
  return { ended: true, error: "배치 결과에서 요청을 찾지 못했습니다." };
}

/** 응답 본문에서 JSON 을 꺼낸다 — 모델이 앞뒤에 말을 붙여도 견딘다. */
function extractJson(message: BatchResult["message"]): unknown {
  const text = (message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("모델이 JSON 을 돌려주지 않았습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

/* ── 3a: 추출 (Opus 5, high, 검색 없음) ────────────────── */

const STAGE3A_SYSTEM = `당신은 신규간호사의 근무 전사본에서 학습 재료를 추출하는 분석가입니다.
전사본은 개인정보가 가려진 상태입니다. 반드시 아래 JSON 스키마 그대로, JSON 하나만 출력하십시오.

{
  "교정목록": [{"id": "C001", "타임스탬프": "02:14:30", "원문구간": "", "교정전": "", "교정후": "", "판단근거": "", "확신도": "상|중|하"}],
  "판독불가": [{"id": "U001", "타임스탬프": "03:41:12", "들린대로": "", "앞뒤맥락": "", "추정범주": "약품|검사|처치|불명"}],
  "교육포인트": [{"id": "E001", "내용": "", "근거_교정ID": ["C001"], "중요도": "상|중|하"}],
  "근무요약": "시간순 사실 정리",
  "근무환경분석": "업무 흐름, 반복되는 병목, 인계 패턴 등 관찰된 것",
  "용어사전": [{"용어": "", "설명": "", "분류": "약품|검사|처치|기타"}]
}

규칙 — 어길 수 없다:
- 목표는 최대한 많이 뽑는 것이다. 교정·판독불가·교육포인트를 빠짐없이 긁어라. 판단의 깊이는 다음 단계가 맡는다.
- 확신이 없으면 교정목록에 넣지 말고 판독불가로 분류하라. 그럴듯한 약품명을 추측해 채우지 마라.
- 애매하면 버리지 말고 확신도 "하"로라도 남겨라. 걸러내는 건 다음 단계가 한다.
- 모든 교정에 판단근거를 채워라.
- 교육포인트는 근거_교정ID 로 실제 교정 항목과 연결하라.
- 전사본에 없는 내용을 추가하지 마라.`;

async function submit3a(shiftId: string): Promise<void> {
  const transcript = await maskedTranscript(shiftId);
  if (!transcript.trim()) throw new Error("전사본이 없습니다. 먼저 전사를 실행하십시오.");
  const batchId = await submitBatch(`3a-${shiftId}`, {
    model: "claude-opus-5",
    max_tokens: 32000,
    // temperature 는 Opus 5 에서 제거된 파라미터라 보낼 수 없다(400).
    // 결정성 요구는 adaptive thinking + effort high 가 대신한다.
    output_config: { effort: "high" },
    system: [{ type: "text", text: STAGE3A_SYSTEM }],
    messages: [{ role: "user", content: `[마스킹된 근무 전사본]\n${transcript}` }],
  });
  await savePipelineJob({ shiftId, stage: "3a", batchId });
  await logDebug(`심층 분석: 3a 배치 제출: ${batchId}`);
}

/* ── 3b: 조사 (Fable 5, 웹 검색 켬) ────────────────────── */

const STAGE3B_SYSTEM = `당신은 1차 분석 JSON 을 검증·보강하는 조사 담당입니다. 웹 검색을 쓸 수 있습니다.
반드시 아래 JSON 스키마 그대로, JSON 하나만 출력하십시오.

{
  "재해석": [{"판독불가_id": "U001", "추정": "", "확신도": "상|중|하", "근거": "", "출처": ["url"], "확인필요": true}],
  "지식보강": [{"대상_id": "C001", "내용": "용법, 주의사항, 상호작용 등", "출처": ["url"]}],
  "교육포인트_보강": [{"교육포인트_id": "E001", "참고자료": "", "출처": ["url"]}]
}

규칙 — 어길 수 없다:
- 웹 검색으로 얻은 추정은 반드시 "확인필요": true 로 표시하고 '선배에게 확인할 것'으로 분류하라.
  안 들린 구간을 웹 지식으로 채우는 건 그럴듯한 오답을 만들 위험이 가장 큰 작업이다. 확정하지 말고 후보로만 제시하라.
- 모든 조사 결과에 출처 URL 을 반드시 남겨라. 출처를 못 다는 내용은 넣지 마라.
- 전사본 맥락과 모순되는 후보는 제시하지 마라.
- 재해석은 재해석 배열에만 둔다. 교정목록을 만들거나 고치지 마라.`;

async function submit3b(shiftId: string, stage3aJson: string): Promise<void> {
  const transcript = await maskedTranscript(shiftId);
  const batchId = await submitBatch(`3b-${shiftId}`, {
    model: "claude-fable-5",
    max_tokens: 32000,
    system: [{ type: "text", text: STAGE3B_SYSTEM }],
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 15 }],
    messages: [
      {
        role: "user",
        content:
          `[1차 분석 JSON]\n${stage3aJson}\n\n` +
          `[마스킹된 근무 전사본 — 판독불가 앞뒤 맥락 확인용]\n${transcript}`,
      },
    ],
  });
  await savePipelineJob({ shiftId, stage: "3b", batchId });
  await logDebug(`심층 분석: 3b 배치 제출: ${batchId}`);
}

/* ── 4: 보고서·카드 (Gemini 3.7 Flash, 실시간, 검색 없음) ── */

const STAGE4_SYSTEM = `신규간호사의 근무 분석 JSON(1차 추출 + 2차 조사)을 보고서와 암기카드로 만듭니다.
한국어 문체 규칙: 번역투 어미 금지. "~할 수 있습니다" 반복 금지. 간호 현장에서 실제 쓰는 용어 그대로.
카드 앞면은 자연스러운 한국어 의문문으로.
"확인필요": true 인 항목은 절대 카드로 만들지 말 것 — 확인목록으로만 보낼 것.
입력 JSON 에 없는 내용을 지어내지 말 것.`;

const STAGE4_SCHEMA = {
  type: "OBJECT",
  properties: {
    보고서: {
      type: "OBJECT",
      properties: {
        사실정리: { type: "STRING" },
        해석과교육: { type: "STRING" },
        근무환경분석: { type: "STRING" },
      },
      required: ["사실정리", "해석과교육", "근무환경분석"],
    },
    카드: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          앞면: { type: "STRING" },
          뒷면: { type: "STRING" },
          출처ID: { type: "STRING" },
        },
        required: ["앞면", "뒷면"],
      },
    },
    확인목록: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          질문: { type: "STRING" },
          후보: { type: "STRING" },
          근거ID: { type: "STRING" },
          출처: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["질문"],
      },
    },
  },
  required: ["보고서", "카드", "확인목록"],
};

interface Stage4Out {
  보고서: { 사실정리: string; 해석과교육: string; 근무환경분석: string };
  카드: { 앞면: string; 뒷면: string; 출처ID?: string }[];
  확인목록: { 질문: string; 후보?: string; 근거ID?: string; 출처?: string[] }[];
}

async function runStage4(shiftId: string, stage3a: string, stage3b: string): Promise<void> {
  const key = await getApiKey("gemini");
  if (!key) throw new Error("Gemini API 키가 없습니다.");
  const res = await fetch(`${GEMINI_API}/models/gemini-3.7-flash:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: STAGE4_SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [{ text: `[1차 추출]\n${stage3a}\n\n[2차 조사]\n${stage3b}` }],
        },
      ],
      generationConfig: {
        temperature: 0,
        response_mime_type: "application/json",
        response_schema: STAGE4_SCHEMA,
        max_output_tokens: 32768,
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini 보고서 생성 오류 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: unknown;
  };
  await appendPipelineUsage(shiftId, { stage: "4", usage: data.usageMetadata, at: Date.now() });
  const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const out = JSON.parse(raw) as Stage4Out;

  // 보고서 — 마크다운 섹션으로 저장. 임상 판단 모드가 섹션 단위로 고친다.
  const markdown =
    `## 사실 정리\n\n${out.보고서.사실정리.trim()}\n\n` +
    `## 해석·교육 포인트\n\n${out.보고서.해석과교육.trim()}\n\n` +
    `## 근무환경 분석\n\n${out.보고서.근무환경분석.trim()}\n`;
  await saveShiftReport(shiftId, markdown, {
    deep: true,
    stage3a: JSON.parse(stage3a),
    stage3b: JSON.parse(stage3b),
  });

  // 카드 — 확인필요 항목은 위 시스템 규칙으로 이미 걸렀지만, 여기서도 확인목록과 분리 저장.
  const db = await getDb();
  const now = Date.now();
  for (let i = 0; i < out.카드.length; i++) {
    const c = out.카드[i];
    const id = `card_dp_${shiftId.replace(/[^0-9A-Za-z]/g, "")}_${i}_${now.toString(36)}`;
    await db.runAsync(
      `INSERT INTO cards (id, kind, front, back, entry_id, shift_id, source_ids, created_at)
       VALUES (?, 'definition', ?, ?, '', ?, ?, ?)`,
      [id, c.앞면, c.뒷면, shiftId, JSON.stringify(c.출처ID ? [c.출처ID] : []), now],
    );
    await db.runAsync(
      `INSERT INTO review_states (card_id, due_at) VALUES (?, ?) ON CONFLICT(card_id) DO NOTHING`,
      [id, now],
    );
  }

  // 확인 목록 — 4단계 산출 + 3b 재해석(확인필요) 둘 다.
  for (const cf of out.확인목록) {
    await addConfirmation({
      shiftId,
      sourceId: cf.근거ID,
      question: cf.질문,
      candidate: cf.후보,
      sources: cf.출처 ?? [],
    });
  }
  const st3b = JSON.parse(stage3b) as {
    재해석?: { 판독불가_id?: string; 추정?: string; 근거?: string; 출처?: string[]; 확인필요?: boolean }[];
  };
  for (const r of st3b.재해석 ?? []) {
    if (!r.확인필요) continue;
    await addConfirmation({
      shiftId,
      sourceId: r.판독불가_id,
      question: `판독불가 구간(${r.판독불가_id ?? "?"}) — 선배에게 확인할 것`,
      candidate: r.추정,
      sources: r.출처 ?? [],
    });
  }

  await savePipelineJob({ shiftId, stage: "done" });
  await logDebug(
    `심층 분석: 4단계 완료 — 카드 ${out.카드.length}장, 확인 목록 ${out.확인목록.length + (st3b.재해석?.filter((r) => r.확인필요).length ?? 0)}건`,
  );
}

/* ── 오케스트레이션 ─────────────────────────────────────── */

function usageOf(message: BatchResult["message"]): unknown {
  return (message as { usage?: unknown } | undefined)?.usage ?? null;
}

export function describeStage(job: PipelineJobRow | null): PipelineState {
  if (!job) return { stage: "idle", detail: "아직 심층 분석을 돌리지 않았습니다." };
  switch (job.stage) {
    case "3a":
      return { stage: "3a", detail: "1차 추출 중 — Claude Opus 5 배치가 돌고 있습니다 (수 분~수십 분)." };
    case "3b":
      return { stage: "3b", detail: "2차 조사 중 — Claude Fable 5 가 웹 검색과 함께 검증하고 있습니다." };
    case "4":
      return { stage: "4", detail: "보고서·카드 생성 대기 — 진행 확인을 누르면 마무리합니다." };
    case "done":
      return { stage: "done", detail: "심층 분석 완료 — 보고서·카드·확인 목록이 준비됐습니다." };
    case "error":
      return { stage: "error", detail: "심층 분석이 실패했습니다.", error: job.error ?? undefined };
    default:
      return { stage: "idle", detail: "" };
  }
}

/** 심층 분석 시작 — 3a 배치를 제출한다. */
export async function startDeepAnalysis(shiftId: string): Promise<PipelineState> {
  const ready = await pipelineReady();
  if (!ready.ok) throw new Error(ready.reason);
  await submit3a(shiftId);
  return describeStage(await getPipelineJob(shiftId));
}

/**
 * 진행을 한 걸음 민다 — 배치가 끝났으면 결과를 거두고 다음 단계를 제출한다.
 * 화면이 열려 있을 때 주기적으로, 또는 '진행 확인' 버튼으로 부른다.
 */
export async function checkDeepAnalysis(shiftId: string): Promise<PipelineState> {
  const job = await getPipelineJob(shiftId);
  if (!job) return describeStage(null);
  try {
    if (job.stage === "3a" && job.batch_id) {
      const r = await pollBatch(job.batch_id, `3a-${shiftId}`);
      if (!r.ended) return describeStage(job);
      if (r.error) throw new Error(`1차 추출 실패: ${r.error}`);
      const json = JSON.stringify(extractJson(r.message));
      await appendPipelineUsage(shiftId, { stage: "3a", usage: usageOf(r.message), at: Date.now() });
      await savePipelineJob({ shiftId, stage: "3a-done", stage3a: json });
      await submit3b(shiftId, json);
    } else if (job.stage === "3a-done") {
      // 3b 제출 직전에 앱이 죽은 경우 — 저장된 3a 결과로 다시 제출한다.
      await submit3b(shiftId, job.stage3a ?? "{}");
    } else if (job.stage === "3b" && job.batch_id) {
      const r = await pollBatch(job.batch_id, `3b-${shiftId}`);
      if (!r.ended) return describeStage(job);
      if (r.error) throw new Error(`2차 조사 실패: ${r.error}`);
      const json = JSON.stringify(extractJson(r.message));
      await appendPipelineUsage(shiftId, { stage: "3b", usage: usageOf(r.message), at: Date.now() });
      await savePipelineJob({ shiftId, stage: "4", stage3b: json });
      const fresh = await getPipelineJob(shiftId);
      await runStage4(shiftId, fresh?.stage3a ?? "{}", json);
    } else if (job.stage === "4") {
      await runStage4(shiftId, job.stage3a ?? "{}", job.stage3b ?? "{}");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "알 수 없는 오류";
    await savePipelineJob({ shiftId, stage: "error", error: msg });
    await logDebug(`심층 분석: 실패: ${msg}`);
  }
  return describeStage(await getPipelineJob(shiftId));
}
