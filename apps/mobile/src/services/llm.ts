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

import { buildGlossaryForLLM, buildCorrectionRulesForLLM, type Lexicon } from "@nsr/core";
import { getSetting, setSetting } from "../db";
import { redactForNetwork } from "./export";

/**
 * 공급자 선택.
 *
 * OAuth 에 대해 정직하게: OpenAI 의 "ChatGPT 로 로그인" 은 승인받은 앱만 쓰는
 * 베타이고, Anthropic 은 서드파티 앱용 OAuth 자체가 없다. 그래서 양쪽 다
 * API 키 방식이다. 키는 기기 보안 저장소에만 있다.
 */
export type LlmProvider = "anthropic" | "openai" | "kimi" | "gemini" | "custom";

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
  // 전사(Gemini 모드)와 같은 키를 쓴다 — 구글 AI 키는 하나면 된다.
  gemini: "gemini.apiKey",
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
  id?: string;
  name?: string;
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
  stop_reason?: string;
  usage?: { cache_read_input_tokens?: number; input_tokens?: number; output_tokens?: number };
}> {
  const apiKey = await getApiKey("anthropic");
  if (!apiKey) {
    throw new Error(
      "API 열쇠(키)가 읎어요! 설정 > AI 선배 셋팅 가서 꽂아주세용 " +
        "열쇠는 폰 안쪽 깊숙한 금고(키체인/키스토어)에만 박아둬서 절대 안 털려요 안심!",
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
    if (res.status === 401) throw new Error("엥? API 열쇠(키) 짝퉁인데요? 안 맞음");
    if (res.status === 429) {
      throw new Error("앗 너무 많이 찔러서 AI가 뻗었어요 ㅠㅠ 쿨타임 좀 돌고 다시 와주세용");
    }
    throw new Error(`API 놈이 에러 뱉음 ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

// Kimi(Moonshot)는 OpenAI 호환이라 callOpenAi 를 그대로 탄다.
// k2.6 은 response_format json_schema 까지 지원한다 (2026-08 조사).
const KIMI_BASE = "https://api.moonshot.ai/v1";
// Gemini 는 OpenAI 호환 게이트웨이를 제공한다 — callOpenAi 를 그대로 탄다.
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * 공급자별 모델 선택.
 *
 * 기본값은 "다듬기·요약에 충분하면서 싼" 쪽으로 골랐다. 목록은 화면의
 * 추천 칩일 뿐이고 저장은 자유 문자열이다 — 모델 이름은 몇 달마다 바뀌므로
 * 목록에 없는 id 를 직접 넣을 수 있어야 오래간다.
 * (모델 id 는 2026-08 기준 각 공식 문서에서 확인한 값이다. Kimi k2 계열은
 * 2026-05 에, Gemini 2.5 계열과 GPT-5.1 은 2026 상반기에 단종·폐기됐다.)
 */
export const MODEL_CHOICES: Record<Exclude<LlmProvider, "custom">, { id: string; hint: string }[]> = {
  anthropic: [
    { id: "claude-opus-5", hint: "킹갓제너럴 정확도 (국룰)" },
    { id: "claude-fable-5", hint: "최고 존엄 — 근데 돈 엄청 깨짐 주의" },
    { id: "claude-sonnet-5", hint: "밸런스 패치 — 가격 반값 할인!" },
    { id: "claude-haiku-4-5", hint: "젤 빠르고 젤 쌈 (가성비충)" },
  ],
  openai: [
    { id: "gpt-5.6-terra", hint: "밸런스 패치 (국룰)" },
    { id: "gpt-5.6-sol", hint: "킹갓제너럴 정확도" },
    { id: "gpt-5.6-luna", hint: "젤 저렴이 (가성비)" },
  ],
  kimi: [
    { id: "kimi-k3", hint: "국밥 기본 — 제일 최신형 똑똑이" },
    { id: "kimi-k2.6", hint: "라떼 구형 — 옛날 계정 쓴 사람만 모심" },
  ],
  gemini: [
    { id: "gemini-3.7-flash", hint: "국밥 기본 — 공짜 티어 완전 혜자 낭낭함" },
    { id: "gemini-3.1-pro-preview", hint: "킹갓제너럴 정확도" },
    { id: "gemini-3.5-flash-lite", hint: "젤 저렴이 (가성비)" },
  ],
};

const DEFAULT_MODELS: Record<Exclude<LlmProvider, "custom">, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.6-terra",
  kimi: "kimi-k3",
  gemini: "gemini-3.7-flash",
};

/**
 * 단종된 모델 id 를 후속 모델로 옮긴다. 옛 설정이 저장돼 있으면 언젠가
 * 요청이 통째로 실패한다 — 조용히 같은 급의 현행 모델로 보낸다.
 */
const RETIRED_MODELS: Record<string, string> = {
  "gemini-2.5-flash": "gemini-3.7-flash",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
  "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
  "kimi-k2-turbo-preview": "kimi-k3",
  "kimi-latest": "kimi-k3",
};

export function migrateRetiredModel(id: string): string {
  return RETIRED_MODELS[id] ?? id;
}

export async function getModelFor(provider: LlmProvider): Promise<string> {
  if (provider === "custom") return (await getCustomServer())?.model ?? "";
  const saved = await getSetting<string>(`llm.model.${provider}`, "");
  return migrateRetiredModel(saved.trim()) || DEFAULT_MODELS[provider];
}

export async function setModelFor(provider: LlmProvider, model: string): Promise<void> {
  if (provider === "custom") return; // Ollama 는 서버 설정의 모델 칸을 쓴다.
  await setSetting(`llm.model.${provider}`, model.trim());
}

/**
 * OpenAI 호출. Anthropic 과 같은 이유로 SDK 없이 fetch 다.
 * schema 를 주면 structured output 으로 강제해 JSON 만 받는다.
 */
async function callOpenAi(input: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  schema?: { name: string; schema: unknown };
  /** 단계별 고정 모델(심층 파이프라인 5단계 등) — 공급자 선택을 무시하고 이걸 쓴다. */
  override?: { provider: "openai" | "kimi" | "gemini"; model: string };
}): Promise<string> {
  // "custom" 이면 내 서버(OpenAI 호환)로 간다. Ollama 는 키가 없어도 되므로
  // 키는 있을 때만 붙인다. 이 경로 덕에 유료 API 없이도 보조 기능이 돈다.
  const provider = input.override?.provider ?? (await getProvider());
  const custom = provider === "custom" ? await getCustomServer() : null;
  if (provider === "custom" && !custom) {
    throw new Error("엥 내 서버 주소가 비었어요! 설정 > AI 선배 셋팅 가서 주소랑 녀석(모델) 좀 채워줘용");
  }
  const apiKey = await getApiKey(provider === "anthropic" ? "openai" : provider);
  if (!custom && !apiKey) {
    throw new Error(
      "API 열쇠(키)가 읎어요! 설정 > AI 선배 셋팅 가서 꽂아주세용",
    );
  }

  const base = custom
    ? custom.baseUrl.replace(/\/+$/, "")
    : provider === "kimi"
      ? KIMI_BASE
      : provider === "gemini"
        ? GEMINI_BASE
        : "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model:
        input.override?.model ??
        (custom ? custom.model : await getModelFor(provider === "anthropic" ? "openai" : provider)),
      // Gemini 호환 게이트웨이는 옛 이름(max_tokens)이 확실하게 통한다.
      ...(provider === "gemini" && !custom
        ? { max_tokens: input.maxTokens }
        : { max_completion_tokens: input.maxTokens }),
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
    if (res.status === 401) throw new Error("엥? API 열쇠(키) 짝퉁인데요? 안 맞음");
    if (res.status === 429) {
      throw new Error("앗 너무 굴려서 지쳤거나 잔고(크레딧) 털렸어요 쿨타임 차고 다시 고!");
    }
    throw new Error(`API 놈이 뻘소 시전 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (data.usage) {
    // 사용량은 디버그 로그로 남긴다 — "이번 달 얼마 썼나"의 원천 기록.
    const { logDebug } = await import("./debug");
    void logDebug(
      `LLM usage(${provider}): in ${data.usage.prompt_tokens ?? "?"} / out ${data.usage.completion_tokens ?? "?"}`,
    );
  }
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
  // 확정된 오인식 대응표. 용어집(aliases)만으로는 "대노관"이 데노간인 줄 모른다.
  const rules = buildCorrectionRulesForLLM(lexicon);

  if ((await getProvider()) !== "anthropic") {
    const text = await callOpenAi({
      system: `${POST_EDIT_SYSTEM}\n\n${rules}\n\n참고 용어집:\n${glossary}`,
      messages: [{ role: "user", content: redacted.text }],
      maxTokens: 16000,
    });
    return { text, redactedCount: redacted.result.redactedCount, cacheHit: false };
  }

  const response = await callAnthropic({
    model: await getModelFor("anthropic"),
    max_tokens: 16000,
    system: [
      { type: "text", text: POST_EDIT_SYSTEM },
      {
        type: "text",
        text: `${rules}\n\n참고 용어집:\n${glossary}`,
        // 규칙표와 용어집은 요청마다 동일하다. 1시간 캐시로 반복 요청 비용을 줄인다.
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
    model: await getModelFor("anthropic"),
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
    throw new Error("엥? 녀석이 뻘소리로 답했어요(구조화 실패). 다시 한 번 찔러볼게요");
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
  opts?: {
    /**
     * 심층 파이프라인 5단계(일상 대화) — gemini-3.7-flash 고정, 읽기 전용,
     * 세션 대화 전체와 카드·보고서 전체가 상시 컨텍스트로 실린다.
     * 3.7-flash 는 1M 컨텍스트에 긴 입력 할증이 없어 자르지 않는다.
     */
    pipeline?: boolean;
  },
): Promise<string> {
  // 파이프라인 모드는 대화 전체를 유지한다(사양). 아니면 최근 12턴.
  const trimmed = opts?.pipeline ? [...history] : history.slice(-12);
  // 첫 턴은 user 여야 한다 (잘린 히스토리가 assistant 로 시작할 수 있다).
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

  // 파이프라인 5단계: 모델 고정 + 읽기 전용 규칙. 수정 도구는 아예 노출되지
  // 않으므로 구조적으로 수정이 불가능하고, 이 규칙은 안내 문구용이다.
  if (opts?.pipeline) {
    system +=
      "\n\n[권한 — 읽기 전용]\n" +
      "당신은 카드·보고서·공부 목록을 수정할 수 없습니다. 수정이 필요한 요청이 오면 " +
      "\"화면 위의 '임상 판단' 버튼으로 임상 판단 모드로 전환해야 합니다\"라고 안내하십시오.";
    return callOpenAi({
      system,
      messages,
      maxTokens: 1500,
      override: { provider: "gemini", model: "gemini-3.7-flash" },
    });
  }

  if ((await getProvider()) !== "anthropic") {
    return callOpenAi({ system, messages, maxTokens: 700 });
  }
  const response = await callAnthropic({
    model: await getModelFor("anthropic"),
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

/* ── 심층 파이프라인 5·5b — 상시 컨텍스트와 임상 판단 승격 ── */

/**
 * 5단계 상시 컨텍스트 — 카드 전체 + 최신 보고서 전체 + 열린 확인 목록.
 * 남의 서버로 가므로 여기서 통째로 비식별화한다.
 */
export async function buildDeepChatContext(): Promise<string> {
  const { listCards, listShiftReports, getShiftReportMarkdown, listConfirmations } = await import(
    "../db"
  );
  let ctx = "";
  const reports = await listShiftReports(1);
  if (reports[0]) {
    const md = await getShiftReportMarkdown(reports[0].shiftId);
    if (md) ctx += `## 최근 근무 보고서 (${reports[0].shiftId.split(":")[0]})\n${md}\n`;
  }
  const cards = await listCards(1000);
  if (cards.length > 0) {
    ctx += `\n## 암기카드 전체 (${cards.length}장)\n${cards
      .map((c) => `- [${c.id}] 앞: ${c.front} / 뒤: ${c.back}`)
      .join("\n")}`;
  }
  const open = await listConfirmations();
  if (open.length > 0) {
    ctx += `\n\n## 확인 목록 (선배에게 확인할 것 — 아직 확정 아님)\n${open
      .map((c) => `- [${c.id}] ${c.question}${c.candidate ? ` (후보: ${c.candidate})` : ""}`)
      .join("\n")}`;
  }
  const red = await redactForNetwork(ctx);
  return red.text;
}

const CLINICAL_SYSTEM = `당신은 신규간호사의 학습 자료를 함께 다듬는 선배 간호사입니다(임상 판단 모드).
카드·보고서·확인 목록을 도구로 수정할 수 있습니다.

규칙:
- 모든 수정에는 reason(왜 바꾸는지)을 반드시 채우십시오. 이력에 남습니다.
- 배치 분석 때 내린 판단(교정목록의 판단근거, 지식보강)이 컨텍스트에 있습니다 — 그 위에서 설명하십시오.
- 웹 검색으로 얻은 내용은 카드로 만들지 마십시오. 후보로 말하고 '선배에게 확인'을 권하십시오.
- 의학적 확신이 없는 내용을 카드로 굳히지 마십시오. 애매하면 resolve 하지 말고 그대로 두십시오.
- 합니다체로, 짧고 명확하게. 수정했으면 무엇을 왜 바꿨는지 말로도 알려 주십시오.`;

const CLINICAL_TOOLS = [
  {
    name: "update_card",
    description: "암기카드의 앞면/뒷면을 고친다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        card_id: { type: "string" },
        front: { type: "string" },
        back: { type: "string" },
        reason: { type: "string", description: "왜 바꾸는지 — 이력에 남는다" },
      },
      required: ["card_id", "front", "back", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_card",
    description: "잘못 만들어진 카드를 삭제(정지)한다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { card_id: { type: "string" }, reason: { type: "string" } },
      required: ["card_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "add_card",
    description: "새 암기카드를 만든다. 웹 검색으로 얻은 내용은 만들지 않는다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        front: { type: "string", description: "자연스러운 한국어 의문문" },
        back: { type: "string" },
        source_id: { type: "string", description: "근거 항목 id (C001 등). 없으면 빈 문자열" },
        reason: { type: "string" },
      },
      required: ["front", "back", "source_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "update_report_section",
    description: "최근 근무 보고서의 한 섹션을 교체한다. section 은 '사실 정리'|'해석·교육 포인트'|'근무환경 분석'.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string" },
        content: { type: "string" },
        reason: { type: "string" },
      },
      required: ["section", "content", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_confirmation",
    description: "확인 목록 항목을 해소한다 — 선배에게 확인한 결과를 적는다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        result: { type: "string", description: "확인된 사실" },
        reason: { type: "string" },
      },
      required: ["item_id", "result", "reason"],
      additionalProperties: false,
    },
  },
];

export interface ClinicalReply {
  text: string;
  /** 실제로 실행된 수정 — 화면이 "무엇이 바뀌었나"를 보여줄 재료. */
  actions: string[];
}

/** 대략의 토큰 추정 — 한국어 혼합 텍스트 기준. 5b 의 18만 토큰 경고에 쓴다. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 2);
}

/** 도구 실행부 — Claude(경로1)와 Gemini(경로2) 루프가 같은 실행기를 쓴다. */
async function runClinicalTool(
  name: string,
  args: Record<string, string>,
  reportShiftId: string | undefined,
): Promise<{ result: string; action?: string }> {
  const db = await import("../db");
  if (name === "update_card") {
    const ok = await db.clinicalUpdateCard(args.card_id, args.front, args.back, args.reason);
    return ok
      ? { result: "예쁘게 고쳐놨어요", action: `카드 수정(${args.card_id}) — ${args.reason}` }
      : { result: "엥? 그 번호 단어장이 안 보여요" };
  }
  if (name === "delete_card") {
    const ok = await db.clinicalDeleteCard(args.card_id, args.reason);
    return ok
      ? { result: "가차 없이 펑! 날렸어요", action: `카드 삭제(${args.card_id}) — ${args.reason}` }
      : { result: "엥? 그 번호 단어장이 안 보여요" };
  }
  if (name === "add_card") {
    const id = await db.clinicalAddCard({
      front: args.front,
      back: args.back,
      sourceId: args.source_id || undefined,
      reason: args.reason,
    });
    return id
      ? { result: `새 단어장 뚝딱! (id: ${id})`, action: `카드 추가 — ${args.reason}` }
      : {
          result:
            "빠꾸머금: source_id가 족보에 없는 유령 번호예요! 근거 없는 뇌피셜 단어장은 금지 물음표 살인마 리스트로 넘겨버리세요!",
        };
  }
  if (name === "update_report_section") {
    if (!reportShiftId) return { result: "엥? 뜯어고칠 리포트가 안 보여요" };
    const ok = await db.clinicalUpdateReportSection(
      reportShiftId,
      args.section,
      args.content,
      args.reason,
    );
    return ok
      ? { result: "리포트 찰지게 고쳐놨어요", action: `보고서 '${args.section}' 수정 — ${args.reason}` }
      : { result: "엥? 리포트가 없는데요" };
  }
  if (name === "resolve_confirmation") {
    const ok = await db.resolveConfirmation(args.item_id, args.result, args.reason);
    return ok
      ? { result: "물음표 리스트에서 시원하게 지워버림 싹-", action: `확인 해소(${args.item_id}) — ${args.result}` }
      : { result: "엥? 그 번호 궁금증이 안 보여요" };
  }
  return { result: "엥 이건 모르는 스킬인데?" };
}

/**
 * 5b — 임상 판단 승격. 수동 버튼으로만 들어온다(자동 라우팅 없음).
 * 경로에 따라 모델이 다르다: Claude 경로는 claude-opus-5(high),
 * GPT+Gemini 경로는 gemini-3.1-pro-preview — 이 자리에서는 추론력보다
 * 모르는 것을 모른다고 말하는 성질이 중요하다(사양, 뒤집지 말 것).
 */
export async function clinicalChat(
  history: ChatTurn[],
  input: {
    /** 5단계 컨텍스트 + 관련 판단근거·검증결과·지식보강. 호출부가 비식별화해 넘긴다. */
    context: string;
    reportShiftId?: string;
    webSearch?: boolean;
  },
): Promise<ClinicalReply> {
  const path = await getSetting<string>("ai.path", "claude");
  const trimmed = [...history];
  while (trimmed.length > 0 && trimmed[0].role !== "user") trimmed.shift();
  const redactedTurns = await Promise.all(
    trimmed.map(async (m) => ({
      role: m.role,
      content: m.role === "user" ? (await redactForNetwork(m.text)).text : m.text,
    })),
  );

  if (path === "hybrid") return clinicalChatGemini(redactedTurns, input);
  return clinicalChatAnthropic(redactedTurns, input);
}

async function clinicalChatAnthropic(
  redactedTurns: { role: "user" | "assistant"; content: string }[],
  input: { context: string; reportShiftId?: string; webSearch?: boolean },
): Promise<ClinicalReply> {
  const messages: unknown[] = [...redactedTurns];
  const tools: unknown[] = [...CLINICAL_TOOLS];
  if (input.webSearch) {
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
  }
  const actions: string[] = [];
  const texts: string[] = [];

  for (let round = 0; round < 8; round++) {
    const response = await callAnthropic({
      model: "claude-opus-5",
      max_tokens: 8000,
      output_config: { effort: "high" },
      system: [
        { type: "text", text: CLINICAL_SYSTEM },
        { type: "text", text: `[학습 자료·배치 판단 컨텍스트]\n${input.context}` },
      ],
      tools,
      messages,
    });
    const { logDebug } = await import("./debug");
    await logDebug(
      `임상 판단 usage(anthropic): in ${response.usage?.input_tokens ?? "?"} / out ${response.usage?.output_tokens ?? "?"}`,
    );
    for (const b of response.content) {
      if (b.type === "text" && b.text) texts.push(b.text);
    }
    if (response.stop_reason !== "tool_use") break;

    const toolResults: unknown[] = [];
    for (const b of response.content) {
      if (b.type !== "tool_use" || !b.id || !b.name) continue;
      // 이스케이프가 모델마다 달라 항상 파서를 거친다.
      const args = (typeof b.input === "string" ? JSON.parse(b.input) : b.input) as Record<
        string,
        string
      >;
      try {
        const out = await runClinicalTool(b.name, args, input.reportShiftId);
        if (out.action) actions.push(out.action);
        toolResults.push({ type: "tool_result", tool_use_id: b.id, content: out.result });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: `폭망: ${e instanceof Error ? e.message : "귀신 곡할 노릇(원인 모름)"}`,
          is_error: true,
        });
      }
    }
    if (toolResults.length === 0) break;
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return { text: texts.join("\n").trim() || "(수술 끝! 다 고쳤습니다)", actions };
}

/** 하이브리드 5b — Gemini 3.1 Pro 를 OpenAI 호환 게이트웨이의 함수 호출로 돌린다. */
async function clinicalChatGemini(
  redactedTurns: { role: "user" | "assistant"; content: string }[],
  input: { context: string; reportShiftId?: string; webSearch?: boolean },
): Promise<ClinicalReply> {
  const apiKey = await getApiKey("gemini");
  if (!apiKey) throw new Error("구글 AI 열쇠(키)가 어딨어요! 설정 → 필수 셋팅 가서 꽂아주세용");
  const system =
    `${CLINICAL_SYSTEM}\n\n[학습 자료·배치 판단 컨텍스트]\n${input.context}` +
    (input.webSearch
      ? "\n\n웹 검색이 필요하면 검색 결과를 답에 인용하되, 검색으로 얻은 내용은 카드로 만들지 마십시오."
      : "");

  interface WireMsg {
    role: string;
    content?: string | null;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }
  const messages: WireMsg[] = [
    { role: "system", content: system },
    ...redactedTurns.map((m) => ({ role: m.role, content: m.content })),
  ];
  const tools = CLINICAL_TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const actions: string[] = [];
  const texts: string[] = [];
  for (let round = 0; round < 8; round++) {
    const res = await fetch(`${GEMINI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 8000,
        messages,
        tools,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`임상 판단(Gemini) 오류 ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: WireMsg }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const { logDebug } = await import("./debug");
    await logDebug(
      `임상 판단 usage(gemini): in ${data.usage?.prompt_tokens ?? "?"} / out ${data.usage?.completion_tokens ?? "?"}`,
    );
    const msg = data.choices?.[0]?.message;
    if (!msg) break;
    if (msg.content) texts.push(msg.content);
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
        const out = await runClinicalTool(call.function.name, args, input.reportShiftId);
        if (out.action) actions.push(out.action);
        result = out.result;
      } catch (e) {
        result = `폭망: ${e instanceof Error ? e.message : "귀신 곡할 노릇(원인 모름)"}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  return { text: texts.join("\n").trim() || "(수술 끝! 다 고쳤습니다)", actions };
}

/** 대화를 시작할 수 있는 상태인가 — 공급자 설정이 되어 있는가. */
export async function llmReady(): Promise<{ ok: boolean; reason?: string }> {
  const p = await getProvider();
  if (p === "custom") {
    return (await getCustomServer())
      ? { ok: true }
      : { ok: false, reason: "엥 내 서버 주소가 비었어요! 설정 → AI 선배 셋팅 가서 채워줘용" };
  }
  return (await getApiKey(p))
    ? { ok: true }
    : { ok: false, reason: "열쇠(키)가 읎어요! 설정 → AI 선배 셋팅 가서 누구 쓸 건지 고르고 꽂아주세용" };
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
        model: await getModelFor("anthropic"),
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });
    }
    return { ok: true, message: "오 찰떡 연결 완료!" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "엥 몰라 귀신 곡할 노릇",
    };
  }
}
