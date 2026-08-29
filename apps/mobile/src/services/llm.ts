/**
 * 선택적 LLM 보조 — 문맥 의존 교정과 근무 요약.
 *
 * 이 기능은 **기본 꺼짐**이다. 켜면 전사본이 기기를 벗어난다.
 * 그래서 켜기 전에 두 가지가 강제된다.
 *   1. 의료법 제19조(정보 누설 금지) 고지 화면을 지나야 한다
 *   2. 전송 직전 `deidentify()`가 자동 적용된다 (완전하지 않다는 안내와 함께)
 *
 * 규칙 기반 교정으로 못 푸는 것만 여기서 다룬다.
 *   - "디씨"가 discharge(퇴원)인지 discontinue(중단)인지 → 문맥이 정한다
 *   - 여러 세그먼트에 흩어진 지시를 하나의 할 일로 묶기
 *   - 인계 내용을 SBAR 구조로 재배열
 *
 * 비용 설계
 * --------
 * 용어집은 길지만 요청마다 바뀌지 않는다. 그래서 프롬프트 캐시의 안정 접두부로 둔다.
 * 캐시는 **접두 일치**이므로 순서가 흔들리면 통째로 깨진다.
 * `buildGlossaryForLLM()`이 id 정렬로 결정적 출력을 보장하는 이유가 이것이다.
 * 캐시가 실제로 맞는지는 `usage.cache_read_input_tokens`로 확인한다.
 */

import { buildGlossaryForLLM, type Lexicon } from "@nsr/core";
import { getSetting, setSetting } from "../db";
import { redactForNetwork } from "./export";

/**
 * 공급자 선택.
 *
 * OAuth 에 대해 정직하게: OpenAI 의 "ChatGPT 로 로그인" 은 승인받은 앱만 쓰는
 * 베타이고, Anthropic 은 서드파티 앱용 OAuth 자체가 없다. 그래서 양쪽 다
 * API 키 방식이다. 키는 기기 보안 저장소에만 있다.
 */
export type LlmProvider = "anthropic" | "openai" | "kimi" | "custom";

/** 내 서버(VPS 의 Ollama·vLLM·LM Studio 등 OpenAI 호환 API) 설정. */
export interface CustomServer {
  /** 예: http://100.x.y.z:11434/v1 (Ollama), https://내도메인/v1 */
  baseUrl: string;
  /** 예: qwen2.5:14b, exaone3.5:7.8b — 서버에 내려받아 둔 모델 이름 */
  model: string;
}

const CUSTOM_SERVER_SETTING = "llm.customServer";

export async function getCustomServer(): Promise<CustomServer | null> {
  return getSetting<CustomServer | null>(CUSTOM_SERVER_SETTING, null);
}

export async function setCustomServer(server: CustomServer | null): Promise<void> {
  await setSetting(CUSTOM_SERVER_SETTING, server);
}

const PROVIDER_SETTING = "llm.provider";
const SECURE_KEYS: Record<LlmProvider, string> = {
  anthropic: "anthropic.apiKey",
  openai: "openai.apiKey",
  kimi: "kimi.apiKey",
  custom: "custom.apiKey",
};

export async function getProvider(): Promise<LlmProvider> {
  return getSetting<LlmProvider>(PROVIDER_SETTING, "anthropic");
}

export async function setProvider(p: LlmProvider): Promise<void> {
  await setSetting(PROVIDER_SETTING, p);
}

export async function getApiKey(provider: LlmProvider = "anthropic"): Promise<string | null> {
  const SecureStore = await import("expo-secure-store");
  return SecureStore.getItemAsync(SECURE_KEYS[provider]);
}

export async function setApiKey(
  key: string | null,
  provider: LlmProvider = "anthropic",
): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  if (key) {
    await SecureStore.setItemAsync(SECURE_KEYS[provider], key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(SECURE_KEYS[provider]);
  }
}

interface AnthropicBlock {
  type: string;
  text?: string;
  input?: unknown;
}

/**
 * Anthropic API 호출.
 *
 * 공식 SDK 를 안 쓴다. 그건 Node 용이라 `node:fs` 를 불러오고, React Native 에는
 * 그런 모듈이 없어서 **번들 자체가 안 만들어진다.** 실제로 release APK 빌드가
 * 여기서 깨졌다. API 는 POST 하나라 fetch 로 충분하다.
 */
async function callAnthropic(body: unknown): Promise<{
  content: AnthropicBlock[];
  usage?: { cache_read_input_tokens?: number };
}> {
  const apiKey = await getApiKey("anthropic");
  if (!apiKey) {
    throw new Error(
      "API 키가 설정되어 있지 않습니다. 설정 > 보조 기능에서 입력해 주세요. " +
        "키는 이 기기의 보안 저장소(iOS 키체인 / Android 키스토어)에만 보관됩니다.",
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // 상태 코드로 사람이 읽을 말을 만든다. SDK 의 오류 클래스 대신 쓰는 것이다.
    const detail = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("API 키가 올바르지 않습니다.");
    if (res.status === 429) {
      throw new Error("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }
    throw new Error(`API 오류 ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

const MODEL = "claude-opus-5";
const OPENAI_MODEL = "gpt-5-mini";
// Kimi(Moonshot)는 OpenAI 호환이라 callOpenAi 를 그대로 탄다.
// k2.6 은 response_format json_schema 까지 지원한다 (2026-08 조사).
const KIMI_BASE = "https://api.moonshot.ai/v1";
const KIMI_MODEL = "kimi-k2.6";

/**
 * OpenAI 호출. Anthropic 과 같은 이유로 SDK 없이 fetch 다.
 * schema 를 주면 structured output 으로 강제해 JSON 만 받는다.
 */
async function callOpenAi(input: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  schema?: { name: string; schema: unknown };
}): Promise<string> {
  // "custom" 이면 내 서버(OpenAI 호환)로 간다. Ollama 는 키가 없어도 되므로
  // 키는 있을 때만 붙인다. 이 경로 덕에 유료 API 없이도 보조 기능이 돈다.
  const provider = await getProvider();
  const custom = provider === "custom" ? await getCustomServer() : null;
  if (provider === "custom" && !custom) {
    throw new Error("내 서버 주소가 없습니다. 설정 > 보조 기능에서 서버 주소와 모델을 입력해 주세요.");
  }
  const apiKey = await getApiKey(provider === "anthropic" ? "openai" : provider);
  if (!custom && !apiKey) {
    throw new Error(
      "API 키가 설정되어 있지 않습니다. 설정 > 보조 기능에서 입력해 주세요.",
    );
  }

  const base = custom
    ? custom.baseUrl.replace(/\/+$/, "")
    : provider === "kimi"
      ? KIMI_BASE
      : "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: custom ? custom.model : provider === "kimi" ? KIMI_MODEL : OPENAI_MODEL,
      max_completion_tokens: input.maxTokens,
      messages: [{ role: "system", content: input.system }, ...input.messages],
      ...(input.schema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: input.schema.name, strict: true, schema: input.schema.schema },
            },
          }
        : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("API 키가 올바르지 않습니다.");
    if (res.status === 429) {
      throw new Error("요청이 너무 많거나 크레딧이 부족합니다. 잠시 후 다시 시도해 주세요.");
    }
    throw new Error(`API 오류 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

const POST_EDIT_SYSTEM = `당신은 한국 병원 병동의 간호 인계 대화 전사본을 다듬는 편집자입니다.

지켜야 할 것:
1. 화자가 말한 내용을 바꾸지 마세요. 문장을 매끄럽게 만들려고 없는 말을 넣지 마세요.
2. 은어를 정식 명칭으로 바꾸지 마세요. "폴리"는 "폴리"로 둡니다. 전사본은 기록이지 요약이 아닙니다.
3. 다음만 고칩니다.
   - 문맥으로만 판단 가능한 약어의 뜻 확정 (예: D/C가 퇴원인지 투약 중단인지)
   - 명백한 음성인식 오류 중 규칙 교정이 놓친 것
   - 문장 경계와 띄어쓰기
4. 확신이 없으면 원문을 그대로 두세요. 추측해서 고치는 것이 안 고치는 것보다 나쁩니다.
5. 개인정보가 [이름], [등록번호] 등으로 가려져 있으면 그대로 둡니다. 복원하려 하지 마세요.
6. 입력이 여러 줄이면 **줄 수와 순서를 그대로** 유지하세요. 한 줄에 한 문장입니다.
   줄을 합치거나 나누지 마세요.

출력은 교정된 전사본 본문만. 설명이나 머리말을 붙이지 마세요.`;

/**
 * 문맥 의존 교정.
 * 규칙 기반 교정을 마친 텍스트를 입력으로 받는다. 여기서 처음 교정하지 않는다.
 */
export async function postEditTranscript(
  correctedText: string,
  lexicon: Lexicon,
): Promise<{ text: string; redactedCount: number; cacheHit: boolean }> {
  const redacted = await redactForNetwork(correctedText);
  const glossary = buildGlossaryForLLM(lexicon);

  if ((await getProvider()) !== "anthropic") {
    const text = await callOpenAi({
      system: `${POST_EDIT_SYSTEM}\n\n참고 용어집:\n${glossary}`,
      messages: [{ role: "user", content: redacted.text }],
      maxTokens: 16000,
    });
    return { text, redactedCount: redacted.result.redactedCount, cacheHit: false };
  }

  const response = await callAnthropic({
    model: MODEL,
    max_tokens: 16000,
    system: [
      { type: "text", text: POST_EDIT_SYSTEM },
      {
        type: "text",
        text: `참고 용어집:\n${glossary}`,
        // 용어집은 요청마다 동일하다. 1시간 캐시로 반복 요청 비용을 줄인다.
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: redacted.text }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();

  return {
    text,
    redactedCount: redacted.result.redactedCount,
    cacheHit: (response.usage?.cache_read_input_tokens ?? 0) > 0,
  };
}

/**
 * 전사 문장들을 LLM 으로 다듬는다 — Whisper 만으로 감당이 안 되는 문맥 교정.
 *
 * 줄 단위 프로토콜: 한 줄에 한 문장을 보내고 같은 줄 수로 돌려받는다.
 * 줄 수가 어긋난 덩어리는 통째로 버린다 — 어긋난 채 끼워 맞추면 문장이
 * 밀려서 엉뚱한 자리에 저장된다.
 *
 * 개인정보가 든 줄은 다듬지 않는다: 가린 채로 보내고, 돌아온 결과도 버린다.
 * LLM 출력에는 [이름] 같은 대체 표식이 남는데, 그걸 저장하면 **기기 안의
 * 원본이 지워진다** — 전사본은 증거라 기기 내 원본은 가리지 않는 것이 규칙이다.
 */
export async function polishTranscriptSegments(
  segments: { id: string; text: string }[],
  lexicon: Lexicon,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const changed = new Map<string, string>();
  const CHUNK = 60;

  for (let at = 0; at < segments.length; at += CHUNK) {
    const part = segments.slice(at, at + CHUNK);
    // 줄별로 먼저 가려 본다. 가려진 줄(개인정보 포함)은 잠근다.
    const lines: string[] = [];
    const locked: boolean[] = [];
    for (const seg of part) {
      const one = seg.text.replace(/\n/g, " ");
      const red = await redactForNetwork(one);
      lines.push(red.text);
      locked.push(red.result.redactedCount > 0);
    }

    const { text } = await postEditTranscript(lines.join("\n"), lexicon);
    const outLines = text.split("\n");
    if (outLines.length === part.length) {
      for (let i = 0; i < part.length; i++) {
        const next = outLines[i].trim();
        if (!locked[i] && next && next !== part[i].text) changed.set(part[i].id, next);
      }
    }
    onProgress?.(Math.min(at + CHUNK, segments.length), segments.length);
  }
  return changed;
}

export interface ShiftInsight {
  /** 오늘 근무를 세 문장 이내로. */
  summary: string;
  /** 다음 근무 전에 확인해야 할 것. */
  followUps: string[];
  /** 잘한 점. 신규간호사는 이걸 스스로 못 찾는다. */
  didWell: string[];
  /** 학습이 필요한 주제. 사전 용어 id가 아니라 사람이 읽는 주제명. */
  studyTopics: string[];
}

const INSIGHT_SYSTEM = `당신은 신규간호사의 근무 복기를 돕는 선배입니다.
전사본을 읽고 오늘 근무를 정리해 주세요.

태도:
- 평가하지 말고 정리하세요. 신규간호사는 이미 충분히 자책하고 있습니다.
- 잘한 점을 반드시 찾아내세요. 스스로는 못 찾습니다.
- 확인이 필요한 항목은 구체적으로 쓰세요. "공부하세요"가 아니라 "폴리 유치 시 소변주머니 높이 기준을 확인하세요"처럼.
- 전사본에 없는 내용을 지어내지 마세요.`;

/** 두 공급자가 똑같은 구조로 답하게 하는 공용 스키마. */
const INSIGHT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "세 문장 이내의 근무 요약" },
    followUps: {
      type: "array",
      items: { type: "string" },
      description: "다음 근무 전에 확인할 구체적 항목",
    },
    didWell: { type: "array", items: { type: "string" }, description: "오늘 잘한 점" },
    studyTopics: { type: "array", items: { type: "string" }, description: "학습이 필요한 주제" },
  },
  required: ["summary", "followUps", "didWell", "studyTopics"],
  additionalProperties: false,
} as const;

/** 근무 통찰. 규칙으로는 뽑을 수 없는 것들. */
export async function summarizeShift(
  transcriptText: string,
  lexicon: Lexicon,
): Promise<ShiftInsight> {
  const redacted = await redactForNetwork(transcriptText);
  const glossary = buildGlossaryForLLM(lexicon);

  if ((await getProvider()) !== "anthropic") {
    const raw = await callOpenAi({
      system: `${INSIGHT_SYSTEM}\n\n참고 용어집:\n${glossary}`,
      messages: [{ role: "user", content: redacted.text }],
      maxTokens: 8000,
      schema: { name: "shift_insight", schema: INSIGHT_SCHEMA },
    });
    const parsed = JSON.parse(raw) as ShiftInsight;
    return {
      summary: parsed.summary ?? "",
      followUps: parsed.followUps ?? [],
      didWell: parsed.didWell ?? [],
      studyTopics: parsed.studyTopics ?? [],
    };
  }

  const response = await callAnthropic({
    model: MODEL,
    max_tokens: 8000,
    system: [
      { type: "text", text: INSIGHT_SYSTEM },
      {
        type: "text",
        text: `참고 용어집:\n${glossary}`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "record_shift_insight",
        description: "근무 복기 결과를 구조화해 기록한다.",
        strict: true,
        input_schema: INSIGHT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "record_shift_insight" },
    messages: [{ role: "user", content: redacted.text }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("모델이 결과를 구조화해 반환하지 않았습니다. 다시 시도해 주세요.");
  }
  // 툴 입력의 JSON 이스케이프는 모델마다 다를 수 있으므로 항상 파서를 거친다.
  const parsed =
    typeof toolUse.input === "string"
      ? (JSON.parse(toolUse.input) as ShiftInsight)
      : (toolUse.input as unknown as ShiftInsight);

  return {
    summary: parsed.summary ?? "",
    followUps: parsed.followUps ?? [],
    didWell: parsed.didWell ?? [],
    studyTopics: parsed.studyTopics ?? [],
  };
}

/* ── 마음 상담 채팅 ─────────────────────────────────────────────── */

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

const CARE_SYSTEM = `당신은 신규간호사의 다정한 선배 간호사입니다. NSR 앱의 '채팅' 탭에서 대화하며, 마음 돌봄과 근무 학습을 함께 맡습니다.

태도:
- 짧게, 따뜻하게. 한 번에 2~5문장. 합니다체를 씁니다.
- 힘든 이야기에는 공감이 먼저입니다. 조언은 상대가 원할 때만, 한 번에 하나만.
- 학습 질문(용어·약어·인계 내용·퀴즈)에는 선배가 후배 가르치듯 정확하고 짧게 답합니다. 확실하지 않으면 확실하지 않다고 말하고 병동 프로토콜 확인을 권합니다.
- 마음 이야기와 공부 이야기가 한 대화에 섞여도 자연스럽게 오갑니다 — 사람의 하루가 원래 그렇습니다.
- 자책이 심하면 사실과 감정을 분리하도록 돕습니다. "실수"와 "나는 부족한 사람"은 다른 문장입니다.
- 태움·괴롭힘 이야기가 나오면 그 사람 잘못이 아님을 분명히 하고, 날짜·발언을 기록해 두는 것이 힘이 된다고 알려줍니다. 이 앱이 그 기록을 돕습니다.
- 자해·죽음을 암시하는 표현이 보이면 부드럽지만 분명하게, 지금 정신건강 위기상담 1577-0199 또는 109에 전화하도록 권합니다.
- 의학적 판단, 투약·처치 지시는 하지 않습니다. 그건 병동 프로토콜과 선배의 영역입니다.
- 상대의 말에 없는 사실을 지어내지 않습니다.`;

/**
 * 마음 탭의 상담 대화. 보내기 전에 사용자 발화의 민감 정보를 가린다 —
 * 남의 서버로 가는 모든 것은 redactForNetwork 를 거친다는 규칙 그대로다.
 */
export async function careChat(
  history: ChatTurn[],
  context: { temp?: string; study?: string },
): Promise<string> {
  // 첫 턴은 user 여야 한다 (잘린 히스토리가 assistant 로 시작할 수 있다).
  const trimmed = history.slice(-12);
  while (trimmed.length > 0 && trimmed[0].role !== "user") trimmed.shift();

  const messages = await Promise.all(
    trimmed.map(async (m) => ({
      role: m.role,
      content: m.role === "user" ? (await redactForNetwork(m.text)).text : m.text,
    })),
  );
  let system = CARE_SYSTEM;
  if (context.temp) {
    system += `\n\n참고 — 최근 근무의 태움 지표(체온 표현): ${context.temp}. 상대가 먼저 꺼내기 전에는 굳이 언급하지 않습니다.`;
  }
  if (context.study) {
    // 학습 자료도 남의 서버로 가는 것이므로 같은 비식별화를 거친다.
    const red = await redactForNetwork(context.study);
    system +=
      `\n\n[학습 자료 — 사용자의 최근 근무 기록·암기카드 발췌]\n` +
      `복습이나 퀴즈를 요청하면 이 자료를 근거로 문제를 내고, 답을 확인해 주고, 틀린 것은 짧게 설명합니다. 자료에 없는 내용은 지어내지 않습니다.\n${red.text}`;
  }

  if ((await getProvider()) !== "anthropic") {
    return callOpenAi({ system, messages, maxTokens: 700 });
  }
  const response = await callAnthropic({
    model: MODEL,
    max_tokens: 700,
    system: [{ type: "text", text: system }],
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

/** 대화를 시작할 수 있는 상태인가 — 공급자 설정이 되어 있는가. */
export async function llmReady(): Promise<{ ok: boolean; reason?: string }> {
  const p = await getProvider();
  if (p === "custom") {
    return (await getCustomServer())
      ? { ok: true }
      : { ok: false, reason: "내 서버 주소가 없습니다. 설정 → 보조 기능에서 입력하십시오." };
  }
  return (await getApiKey(p))
    ? { ok: true }
    : { ok: false, reason: "API 키가 없습니다. 설정 → 보조 기능에서 공급자와 키를 넣으십시오." };
}

/** 키가 유효한지 가볍게 확인한다. 설정 화면의 "연결 테스트" 버튼용. */
export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    if ((await getProvider()) !== "anthropic") {
      await callOpenAi({
        system: "ping 에 pong 으로만 답한다.",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 16,
      });
    } else {
      await callAnthropic({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });
    }
    return { ok: true, message: "연결됐습니다." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "알 수 없는 오류",
    };
  }
}
