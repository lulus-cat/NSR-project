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
const OPENAI_API = "https://api.openai.com/v1";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

export type PipelineStage = "idle" | "3a" | "3b" | "4" | "done" | "error";

export interface PipelineState {
  stage: PipelineStage;
  detail: string;
  error?: string;
}

/* ── AI 경로 — 앱의 필수 설정. 정확히 두 갈래다 ────────── */

export type AiPath = "claude" | "hybrid";

export const AI_PATH_KEY = "ai.path";

/** 경로별 사람이 읽는 설명 — 온보딩·설정 화면이 같은 문장을 쓴다. */
export const AI_PATHS: {
  path: AiPath;
  title: string;
  models: string;
  why: string;
  keys: ("anthropic" | "openai")[];
}[] = [
  {
    path: "claude",
    title: "Claude + Gemini",
    models:
      "팩트 체크+임상 센세: Claude Opus 5 · 폭풍 구글링: Claude Fable 5 · 리포트+입털기: Gemini 3.7 Flash",
    why: "Fable 5 녀석이 헛소리 제일 안 해서 구글링 전담이고, Opus 5는 긴 글 요약 장인이에요. 퀄리티 미침 — 대신 한 달에 대충 치킨 한 마리 값($15~22)",
    keys: ["anthropic"],
  },
  {
    path: "hybrid",
    title: "GPT + Gemini",
    models:
      "팩트 체크: GPT-5.6 Sol · 구글링+임상 센세: Gemini 3.1 Pro / 3.7 Flash · 리포트+입털기: Gemini 3.7 Flash",
    why: "GPT는 포기를 몰라서 먼지까지 싹싹 긁어오고, Gemini는 아니다 싶으면 칼같이 패스해서 거품을 빼줘요. 둘이 성격 반대라 찰떡 콤비! (검증 포함 한 달 치킨 반 마리 값 $9~13)",
    keys: ["openai"],
  },
];

export async function getAiPath(): Promise<AiPath | null> {
  const { getSetting } = await import("../db");
  const v = await getSetting<string>(AI_PATH_KEY, "");
  return v === "claude" || v === "hybrid" ? v : null;
}

export async function setAiPath(path: AiPath): Promise<void> {
  const { setSetting } = await import("../db");
  await setSetting(AI_PATH_KEY, path);
  // 문장 다듬기 같은 단발 기능도 경로의 1차 공급자를 따라간다.
  const { setProvider } = await import("./llm");
  await setProvider(path === "claude" ? "anthropic" : "gemini");
}

/**
 * 이 파이프라인이 돌 수 있는 상태인가 — 선택한 경로의 키가 전부 필요하다.
 * 한쪽이 빠져도 다른 모델로 자동 대체하지 않는다(역할 분담이 안전성의 원천).
 */
export async function pipelineReady(): Promise<{ ok: boolean; reason?: string; path?: AiPath }> {
  const path = await getAiPath();
  if (!path) {
    return {
      ok: false,
      reason: "엥? 콤비 안 골랐어요! 설정 → 필수 셋팅 가서 Claude+Gemini 할 건지 GPT+Gemini 할 건지 찜해주세요",
    };
  }
  const gemini = await getApiKey("gemini");
  if (!gemini) {
    return { ok: false, path, reason: "구글 AI 열쇠(키)가 어딨어요! 설정 → 필수 셋팅 가서 꽂아주세용" };
  }
  if (path === "claude") {
    if (!(await getApiKey("anthropic"))) {
      return {
        ok: false,
        path,
        reason:
          "Claude 열쇠(키)가 없어요! 이 경로는 Claude 전용이라 딴 놈으로 대타 못 뜀 ㅠㅠ 키 꽂아주거나 GPT+Gemini로 갈아타세용",
      };
    }
  } else if (!(await getApiKey("openai"))) {
    return {
      ok: false,
      path,
      reason:
        "OpenAI 열쇠(키)가 없어요! 이 경로는 GPT 전용이라 딴 놈 대타 안 됨 ㅠㅠ 키 꽂아주거나 Claude+Gemini로 갈아타세용",
    };
  }
  return { ok: true, path };
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
  if (!key) throw new Error("Claude 열쇠(키) 없뜸 텅~");
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
    if (res.status === 401) throw new Error("엥 Claude 열쇠(키) 짝퉁인데요? 안 맞음");
    if (detail.includes("retention")) {
      throw new Error(
        "Fable 5 녀석은 30일 보관 셋팅 필수예요. Anthropic 설정 창 가서 쳌쳌!",
      );
    }
    throw new Error(`앗 묶음 배송(배치) 신청 폭망 ${res.status}: ${detail.slice(0, 200)}`);
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
  if (!res.ok) throw new Error(`묶음 배송(배치) 조회 엎어짐 ${res.status}`);
  const data = (await res.json()) as { processing_status: string; results_url?: string };
  if (data.processing_status !== "ended") return { ended: false };
  if (!data.results_url) return { ended: true, error: "어라 배송(결과) 주소가 없어요 ㅠㅠ" };

  const results = await fetch(data.results_url, { headers });
  if (!results.ok) throw new Error(`택배(배치 결과) 다운로드 폭망 ${results.status}`);
  const jsonl = await results.text();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      custom_id: string;
      result: { type: string; message?: BatchResult["message"]; error?: { message?: string } };
    };
    if (row.custom_id !== customId) continue; // 순서 비보장 — id 로만 매칭
    if (row.result.type !== "succeeded") {
      return { ended: true, error: row.result.error?.message ?? `앗 묶음 배송(배치) 터짐 ㅠㅠ (${row.result.type})` };
    }
    return { ended: true, message: row.result.message };
  }
  return { ended: true, error: "엥 택배 상자 안에 내 거 없어요! (결과 못 찾음)" };
}

/** 응답 본문에서 JSON 을 꺼낸다 — 모델이 앞뒤에 말을 붙여도 견딘다. */
function extractJson(message: BatchResult["message"]): unknown {
  const text = (message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("엥 이 녀석이 JSON 모양으로 안 돌려줬어요 ㅠㅠ 빠꾸!");
  return JSON.parse(text.slice(start, end + 1));
}

/* ── 3a: 추출 (Opus 5, high, 검색 없음) ────────────────── */

const STAGE3A_SYSTEM = `당신은 신규간호사의 근무 전사본에서 학습 재료를 추출하는 분석가입니다.
전사본은 개인정보가 가려진 상태입니다. 반드시 아래 JSON 스키마 그대로, JSON 하나만 출력하십시오.

{
  "교정목록": [{"id": "C001", "타임스탬프": "02:14:30", "원문인용": "", "교정전": "", "교정후": "", "판단근거": "", "확신도": "상|중|하"}],
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
- 모든 교정에 원문인용과 판단근거를 채워라. 원문인용은 전사본에서 글자 그대로
  복사한 문장이어야 한다 — 요약하거나 다듬으면 안 된다. 둘 중 하나라도 못 쓰면
  교정목록이 아니라 판독불가로 보내라.
- 교육포인트는 근거_교정ID 로 실제 교정 항목과 연결하라.
- 전사본에 없는 내용을 추가하지 마라.`;

async function submit3a(shiftId: string): Promise<void> {
  const transcript = await maskedTranscript(shiftId);
  if (!transcript.trim()) throw new Error("글로 바뀐 녹음본(전사본)이 없어요! 변환부터 얍 돌리고 오세요");
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
  await logDebug(`초정밀 분석: 3a 택배 발송 슝: ${batchId}`);
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
  await logDebug(`초정밀 분석: 3b 택배 발송 슝: ${batchId}`);
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
  if (!key) throw new Error("구글 AI 열쇠(키) 없뜸 텅~");
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
    throw new Error(`구글 AI 리포트 찍어내기 폭망 ${res.status}: ${detail.slice(0, 200)}`);
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
      question: `웅얼거려서 안 들림(${r.판독불가_id ?? "?"}) — 선배한테 팩트 체크 필수`,
      candidate: r.추정,
      sources: r.출처 ?? [],
    });
  }

  await savePipelineJob({ shiftId, stage: "done" });
  await logDebug(
    `초정밀 분석: 4단계 피니시 — 단어장 ${out.카드.length}장 뚝딱, 선배 물음표 살인마 리스트 ${out.확인목록.length + (st3b.재해석?.filter((r) => r.확인필요).length ?? 0)}건 장전 완!`,
  );
}

/* ── 하이브리드 경로: 3a GPT-5.6 Sol (OpenAI Batch) ────── */
//
// 역할 분담(뒤집지 말 것): GPT 는 기권하지 않는 성질을 재현율로 쓰고,
// Gemini 는 기권하는 성질을 정밀도로 쓴다. GPT 에 검증을 맡기면 자기
// 출력을 무비판 승인하고, Gemini 에 추출을 맡기면 놓친다.

async function openaiKey(): Promise<string> {
  const key = await getApiKey("openai");
  if (!key) throw new Error("OpenAI 열쇠(키) 없뜸 텅~");
  return key;
}

/** OpenAI Batch 는 3단이다: JSONL 파일 업로드 → 배치 생성 → 결과 파일 다운로드. */
async function submitOpenAiBatch(customId: string, body: unknown): Promise<string> {
  const key = await openaiKey();
  const FileSystem = await import("expo-file-system/legacy");
  const line = JSON.stringify({
    custom_id: customId,
    method: "POST",
    url: "/v1/chat/completions",
    body,
  });
  const path = `${FileSystem.cacheDirectory}nsr-batch-${Date.now()}.jsonl`;
  await FileSystem.writeAsStringAsync(path, line + "\n");
  try {
    const form = new FormData();
    form.append("purpose", "batch");
    // RN 의 FormData 파일 파트는 uri 객체다 — Blob 이 아니다.
    form.append("file", {
      uri: path,
      name: "batch.jsonl",
      type: "application/jsonl",
    } as unknown as Blob);
    const up = await fetch(`${OPENAI_API}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    if (!up.ok) throw new Error(`OpenAI 놈한테 파일 던지기 실패 ${up.status}: ${(await up.text()).slice(0, 200)}`);
    const file = (await up.json()) as { id: string };

    const res = await fetch(`${OPENAI_API}/batches`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        input_file_id: file.id,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      }),
    });
    if (!res.ok) throw new Error(`OpenAI 묶음 배송(배치) 생성 폭망 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { id: string }).id;
  } finally {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
  }
}

async function pollOpenAiBatch(
  batchId: string,
  customId: string,
): Promise<{ ended: boolean; text?: string; usage?: unknown; error?: string }> {
  const key = await openaiKey();
  const headers = { authorization: `Bearer ${key}` };
  const res = await fetch(`${OPENAI_API}/batches/${batchId}`, { headers });
  if (!res.ok) throw new Error(`OpenAI 묶음 배송(배치) 조회 엎어짐 ${res.status}`);
  const data = (await res.json()) as {
    status: string;
    output_file_id?: string;
    error_file_id?: string;
  };
  if (["validating", "in_progress", "finalizing"].includes(data.status)) return { ended: false };
  if (data.status !== "completed") {
    let detail = "";
    if (data.error_file_id) {
      const ef = await fetch(`${OPENAI_API}/files/${data.error_file_id}/content`, { headers });
      detail = (await ef.text().catch(() => "")).slice(0, 300);
    }
    return { ended: true, error: `OpenAI 택배 상자 ${data.status}: ${detail}` };
  }
  if (!data.output_file_id) return { ended: true, error: "엥 택배 내용물(결과 파일)이 없어요 텅텅" };
  const out = await fetch(`${OPENAI_API}/files/${data.output_file_id}/content`, { headers });
  if (!out.ok) throw new Error(`택배 결과물 다운로드 폭망 ${out.status}`);
  for (const line of (await out.text()).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      custom_id: string;
      response?: { status_code: number; body?: { choices?: { message?: { content?: string } }[]; usage?: unknown } };
      error?: { message?: string };
    };
    if (row.custom_id !== customId) continue; // 순서 미보장 — id 로만 매칭
    if (row.error || !row.response || row.response.status_code >= 300) {
      return { ended: true, error: row.error?.message ?? `앗 빠꾸 먹음 (${row.response?.status_code})` };
    }
    return {
      ended: true,
      text: row.response.body?.choices?.[0]?.message?.content ?? "",
      usage: row.response.body?.usage,
    };
  }
  return { ended: true, error: "엥 택배 상자 안에 내 거 없어요! (결과 못 찾음)" };
}

/** 3a strict 스키마 — Structured Outputs 는 모든 키 required + additionalProperties:false. */
const STAGE3A_STRICT_SCHEMA = {
  type: "object",
  properties: {
    교정목록: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          타임스탬프: { type: "string" },
          원문인용: { type: "string" },
          교정전: { type: "string" },
          교정후: { type: "string" },
          판단근거: { type: "string" },
          확신도: { type: "string", enum: ["상", "중", "하"] },
        },
        required: ["id", "타임스탬프", "원문인용", "교정전", "교정후", "판단근거", "확신도"],
        additionalProperties: false,
      },
    },
    판독불가: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          타임스탬프: { type: "string" },
          들린대로: { type: "string" },
          앞뒤맥락: { type: "string" },
          추정범주: { type: "string", enum: ["약품", "검사", "처치", "불명"] },
        },
        required: ["id", "타임스탬프", "들린대로", "앞뒤맥락", "추정범주"],
        additionalProperties: false,
      },
    },
    교육포인트: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          내용: { type: "string" },
          근거_교정ID: { type: "array", items: { type: "string" } },
          중요도: { type: "string", enum: ["상", "중", "하"] },
        },
        required: ["id", "내용", "근거_교정ID", "중요도"],
        additionalProperties: false,
      },
    },
    근무요약: { type: "string" },
    근무환경분석: { type: "string" },
    용어사전: {
      type: "array",
      items: {
        type: "object",
        properties: {
          용어: { type: "string" },
          설명: { type: "string" },
          분류: { type: "string", enum: ["약품", "검사", "처치", "기타"] },
        },
        required: ["용어", "설명", "분류"],
        additionalProperties: false,
      },
    },
  },
  required: ["교정목록", "판독불가", "교육포인트", "근무요약", "근무환경분석", "용어사전"],
  additionalProperties: false,
};

async function submit3aHybrid(shiftId: string): Promise<void> {
  const transcript = await maskedTranscript(shiftId);
  if (!transcript.trim()) throw new Error("글로 바뀐 녹음본(전사본)이 없어요! 변환부터 얍 돌리고 오세요");
  const batchId = await submitOpenAiBatch(`3a-${shiftId}`, {
    model: "gpt-5.6-sol",
    // 추론 모델: temperature 미지원(400), 출력 상한은 max_completion_tokens.
    max_completion_tokens: 32000,
    response_format: {
      type: "json_schema",
      json_schema: { name: "stage3a", strict: true, schema: STAGE3A_STRICT_SCHEMA },
    },
    messages: [
      { role: "system", content: STAGE3A_SYSTEM },
      { role: "user", content: `[마스킹된 근무 전사본]\n${transcript}` },
    ],
  });
  await savePipelineJob({ shiftId, stage: "h3a", batchId });
  await logDebug(`하이브리드 정밀 분석: 3a GPT 택배 발송 슝 ${batchId}`);
}

/* ── 3v 검증 패스 — 기계 검증(로컬) + Gemini Flash 판정 ── */

interface Correction {
  id: string;
  타임스탬프: string;
  원문인용: string;
  교정전: string;
  교정후: string;
  판단근거: string;
  확신도: string;
}
interface Stage3aData {
  교정목록: Correction[];
  판독불가: { id: string; 타임스탬프: string; 들린대로: string; 앞뒤맥락: string; 추정범주: string }[];
  교육포인트: unknown[];
  근무요약: string;
  근무환경분석: string;
  용어사전: unknown[];
  검증결과?: { 교정_id: string; 판정: string; 사유: string; 인용일치: boolean }[];
}

/** 원문인용이 전사본에 실제로 있는지 문자열 대조 — LLM 이 필요 없는 부분. */
function machineVerify(data: Stage3aData, transcript: string): { demoted: number } {
  const norm = (s: string) => s.replace(/\s+/g, "");
  const hay = norm(transcript);
  let demoted = 0;
  const kept: Correction[] = [];
  for (const c of data.교정목록) {
    if (c.원문인용 && hay.includes(norm(c.원문인용))) {
      kept.push(c);
      continue;
    }
    demoted++;
    data.판독불가.push({
      id: `M-${c.id}`,
      타임스탬프: c.타임스탬프,
      들린대로: c.교정전,
      앞뒤맥락: c.원문인용 || "(원문 못 찾음 텅~)",
      추정범주: "불명",
    });
  }
  data.교정목록 = kept;
  return { demoted };
}

const STAGE3V_SYSTEM = `다른 모델(GPT)이 만든 교정 목록을 검증합니다. 관대하게 볼 이유가 없습니다.
판정 기준은 "이 교정이 맞을 것 같은가"가 아니라 **"제시된 원문 인용만으로 이 교정이 정당화되는가"**입니다.
일반적인 의학 지식으로 그럴듯하다는 이유로 유지하지 마십시오. 애매하면 유지가 아니라 강등을 고르십시오.
원 항목을 수정하지 말고 판정만 내리십시오. 반드시 JSON 하나만 출력하십시오:
{"검증결과":[{"교정_id":"C001","판정":"유지|강등|기각","사유":"","인용일치":true}]}`;

async function runStage3v(shiftId: string, data: Stage3aData, transcript: string): Promise<void> {
  const key = await getApiKey("gemini");
  if (!key) throw new Error("구글 AI 열쇠(키) 없뜸 텅~");
  if (data.교정목록.length === 0) {
    data.검증결과 = [];
    return;
  }
  const res = await fetch(`${GEMINI_API}/models/gemini-3.7-flash:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: STAGE3V_SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `[교정목록]\n${JSON.stringify(data.교정목록)}\n\n` +
                `[마스킹된 전사본]\n${transcript}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        response_mime_type: "application/json",
        max_output_tokens: 16384,
      },
    }),
  });
  if (!res.ok) throw new Error(`3v 팩트 체크 엎어짐 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: unknown;
  };
  await appendPipelineUsage(shiftId, { stage: "3v", provider: "gemini", usage: body.usageMetadata, at: Date.now() });
  const raw = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const verdicts = (JSON.parse(raw.slice(start, end + 1)) as Stage3aData).검증결과 ?? [];

  // 판정 반영: 유지만 교정목록에 남는다. 강등은 확인 목록으로, 기각은 판독불가로.
  const byId = new Map(verdicts.map((v) => [v.교정_id, v]));
  const kept: Correction[] = [];
  let demote = 0;
  let reject = 0;
  for (const c of data.교정목록) {
    const v = byId.get(c.id);
    if (!v || v.판정 === "유지") {
      kept.push(c);
      continue;
    }
    if (v.판정 === "기각") {
      reject++;
      data.판독불가.push({
        id: `R-${c.id}`,
        타임스탬프: c.타임스탬프,
        들린대로: c.교정전,
        앞뒤맥락: c.원문인용,
        추정범주: "불명",
      });
      continue;
    }
    // 강등 — 카드가 되지 못하고 '선배에게 확인'으로 간다.
    demote++;
    await addConfirmation({
      shiftId,
      sourceId: c.id,
      question: `팩폭 맞고 강등된 녀석 — "${c.교정전}" →"${c.교정후}" 이거 맞아요? (${v.사유})`,
      candidate: c.교정후,
    });
  }
  data.교정목록 = kept;
  data.검증결과 = verdicts;
  await appendPipelineUsage(shiftId, {
    stage: "3v-verdicts",
    유지: kept.length,
    강등: demote,
    기각: reject,
    at: Date.now(),
  });
  await logDebug(`정밀 팩트 체크: 3v 판사님 망치 쾅! — 생존 ${kept.length} · 떡락 ${demote} · 광탈 ${reject}`);
}

/* ── 하이브리드 3b — Gemini 3.1 Pro + 검색 (Gemini Batch) ── */

async function submit3bHybrid(shiftId: string, stage3aJson: string): Promise<void> {
  const key = await getApiKey("gemini");
  if (!key) throw new Error("구글 AI 열쇠(키) 없뜸 텅~");
  const transcript = await maskedTranscript(shiftId);
  const res = await fetch(
    `${GEMINI_API}/models/gemini-3.1-pro-preview:batchGenerateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batch: {
          display_name: `nsr-3b-${Date.now()}`,
          input_config: {
            requests: {
              requests: [
                {
                  request: {
                    system_instruction: { parts: [{ text: STAGE3B_SYSTEM }] },
                    // 검색 도구와 JSON 강제 응답은 함께 못 쓰는 세대가 있어
                    // 프롬프트로 JSON 을 강제하고 파서는 방어적으로 읽는다.
                    tools: [{ google_search: {} }],
                    contents: [
                      {
                        role: "user",
                        parts: [
                          {
                            text:
                              `[1차 분석(검증 반영) JSON]\n${stage3aJson}\n\n` +
                              `[마스킹된 근무 전사본 — 판독불가 앞뒤 맥락 확인용]\n${transcript}`,
                          },
                        ],
                      },
                    ],
                  },
                  metadata: { key: `3b-${shiftId}` },
                },
              ],
            },
          },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini 택배 발송(배치 제출) 엎어짐 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { name?: string };
  if (!data.name) throw new Error("엥 Gemini 택배 상자 이름이 안 보여요");
  await savePipelineJob({ shiftId, stage: "h3b", batchId: data.name });
  await logDebug(`하이브리드 정밀 분석: 3b Gemini 택배 발송 슝 ${data.name}`);
}

async function pollGeminiBatch(
  batchName: string,
  customKey: string,
): Promise<{ ended: boolean; text?: string; usage?: unknown; error?: string }> {
  const key = await getApiKey("gemini");
  const res = await fetch(`${GEMINI_API}/${batchName}?key=${key}`, {});
  if (!res.ok) throw new Error(`Gemini 택배 상자(배치) 조회 엎어짐 ${res.status}`);
  const data = (await res.json()) as {
    metadata?: { state?: string };
    state?: string;
    done?: boolean;
    error?: { message?: string };
    response?: { inlinedResponses?: { inlinedResponses?: unknown[] } | unknown[] };
  };
  const state = data.metadata?.state ?? data.state ?? "";
  if (state.includes("PENDING") || state.includes("RUNNING") || data.done === false) {
    return { ended: false };
  }
  if (data.error || state.includes("FAILED") || state.includes("CANCELLED") || state.includes("EXPIRED")) {
    return { ended: true, error: data.error?.message ?? `택배 현황 ${state}` };
  }
  // 인라인 응답 — 판이 바뀌어도 견디도록 두 가지 꼴을 다 본다.
  const holder = data.response?.inlinedResponses;
  const list = (Array.isArray(holder) ? holder : holder?.inlinedResponses ?? []) as {
    metadata?: { key?: string };
    response?: { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: unknown };
    error?: { message?: string };
  }[];
  for (const row of list) {
    if (row.metadata?.key && row.metadata.key !== customKey) continue;
    if (row.error) return { ended: true, error: row.error.message };
    return {
      ended: true,
      text: (row.response?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
      usage: row.response?.usageMetadata,
    };
  }
  return { ended: true, error: "엥 Gemini 상자 안에 내 거 없어요! (결과 못 찾음)" };
}

/* ── 오케스트레이션 ─────────────────────────────────────── */

function usageOf(message: BatchResult["message"]): unknown {
  return (message as { usage?: unknown } | undefined)?.usage ?? null;
}

export function describeStage(job: PipelineJobRow | null): PipelineState {
  if (!job) return { stage: "idle", detail: "아직 AI 풀악셀(심층 분석) 안 돌렸어용" };
  switch (job.stage) {
    case "3a":
      return { stage: "3a", detail: "1차 영혼 탈탈 터는 중 — Claude Opus 5 형님이 멱살 잡고 돌리는 중 (수 분~수십 분 소요)" };
    case "h3a":
      return { stage: "3a", detail: "1차 영혼 탈탈 터는 중 — GPT-5.6 형님이 멱살 잡고 돌리는 중 (수 분~수십 분 소요)" };
    case "3a-done":
    case "h3a-done":
      return { stage: "3a", detail: "1차 털기 피니시 — '어디쯤 왔나 찌르기' 꾹 누르면 다음 단계로 슝!" };
    case "3b":
      return { stage: "3b", detail: "2차 폭풍 구글링 중 — Claude Fable 5 녀석이 팩트 체크 갈기고 있어용" };
    case "h3b":
      return { stage: "3b", detail: "팩트 체크 프리패스 — Gemini 3.1 Pro 녀석이 구글링으로 탈탈 터는 중!" };
    case "4":
      return { stage: "4", detail: "리포트랑 단어장 굽기 대기 중 — '어디쯤 왔나 찌르기' 꾹 누르면 마무리 피니시!" };
    case "done":
      return { stage: "done", detail: "초정밀 분석 갓벽하게 완료 — 눈물 젖은 리포트, 단어장, 선배한테 물어볼 리스트 장전 완!" };
    case "error":
      return { stage: "error", detail: "앗 초정밀 분석 엎어짐 대참사 ㅠㅠ", error: job.error ?? undefined };
    default:
      return { stage: "idle", detail: "" };
  }
}

/** 심층 분석 시작 — 선택한 경로의 3a 배치를 제출한다. */
export async function startDeepAnalysis(shiftId: string): Promise<PipelineState> {
  const ready = await pipelineReady();
  if (!ready.ok) throw new Error(ready.reason);
  if (ready.path === "hybrid") await submit3aHybrid(shiftId);
  else await submit3a(shiftId);
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
      if (r.error) throw new Error(`1차 영혼 털기 엎어짐: ${r.error}`);
      const json = JSON.stringify(extractJson(r.message));
      await appendPipelineUsage(shiftId, { stage: "3a", usage: usageOf(r.message), at: Date.now() });
      await savePipelineJob({ shiftId, stage: "3a-done", stage3a: json });
      await submit3b(shiftId, json);
    } else if (job.stage === "3a-done") {
      // 3b 제출 직전에 앱이 죽은 경우 — 저장된 3a 결과로 다시 제출한다.
      await submit3b(shiftId, job.stage3a ?? "{}");
    } else if (job.stage === "h3a" && job.batch_id) {
      // 하이브리드: GPT 추출이 끝나면 기계 검증 → 3v 판정까지 여기서 돈다
      // (3v 는 입력이 작아 실시간 Flash 로 충분하다).
      const r = await pollOpenAiBatch(job.batch_id, `3a-${shiftId}`);
      if (!r.ended) return describeStage(job);
      if (r.error) throw new Error(`1차 영혼 털기(GPT) 엎어짐: ${r.error}`);
      await appendPipelineUsage(shiftId, { stage: "3a", provider: "openai", usage: r.usage, at: Date.now() });
      const text = r.text ?? "";
      const s = text.indexOf("{");
      const e = text.lastIndexOf("}");
      if (s < 0 || e <= s) throw new Error("GPT 놈이 뻘소리(JSON 안 줌) 시전 ㅠㅠ");
      const data = JSON.parse(text.slice(s, e + 1)) as Stage3aData;

      const transcript = await maskedTranscript(shiftId);
      const extracted = data.교정목록.length;
      const { demoted } = machineVerify(data, transcript);
      await appendPipelineUsage(shiftId, {
        stage: "3v-machine",
        추출: extracted,
        인용불일치_강등: demoted,
        at: Date.now(),
      });
      await runStage3v(shiftId, data, transcript);

      const json = JSON.stringify(data);
      await savePipelineJob({ shiftId, stage: "h3a-done", stage3a: json });
      await submit3bHybrid(shiftId, json);
    } else if (job.stage === "h3a-done") {
      await submit3bHybrid(shiftId, job.stage3a ?? "{}");
    } else if (job.stage === "h3b" && job.batch_id) {
      const r = await pollGeminiBatch(job.batch_id, `3b-${shiftId}`);
      if (!r.ended) return describeStage(job);
      if (r.error) throw new Error(`2차 폭풍 구글링(Gemini) 엎어짐: ${r.error}`);
      await appendPipelineUsage(shiftId, { stage: "3b", provider: "gemini", usage: r.usage, at: Date.now() });
      const text = r.text ?? "";
      const s = text.indexOf("{");
      const e = text.lastIndexOf("}");
      if (s < 0 || e <= s) throw new Error("Gemini 놈이 뻘소리(JSON 안 줌) 시전 ㅠㅠ");
      const json = JSON.stringify(JSON.parse(text.slice(s, e + 1)));
      await savePipelineJob({ shiftId, stage: "4", stage3b: json });
      const fresh = await getPipelineJob(shiftId);
      await runStage4(shiftId, fresh?.stage3a ?? "{}", json);
    } else if (job.stage === "3b" && job.batch_id) {
      const r = await pollBatch(job.batch_id, `3b-${shiftId}`);
      if (!r.ended) return describeStage(job);
      if (r.error) throw new Error(`2차 폭풍 구글링 엎어짐: ${r.error}`);
      const json = JSON.stringify(extractJson(r.message));
      await appendPipelineUsage(shiftId, { stage: "3b", usage: usageOf(r.message), at: Date.now() });
      await savePipelineJob({ shiftId, stage: "4", stage3b: json });
      const fresh = await getPipelineJob(shiftId);
      await runStage4(shiftId, fresh?.stage3a ?? "{}", json);
    } else if (job.stage === "4") {
      await runStage4(shiftId, job.stage3a ?? "{}", job.stage3b ?? "{}");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "귀신 곡할 노릇 (원인 모름)";
    await savePipelineJob({ shiftId, stage: "error", error: msg });
    await logDebug(`초정밀 분석 폭망: ${msg}`);
  }
  return describeStage(await getPipelineJob(shiftId));
}
