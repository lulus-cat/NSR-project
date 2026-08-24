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

import Anthropic from "@anthropic-ai/sdk";
import { buildGlossaryForLLM, type Lexicon } from "@nsr/core";
import { redactForNetwork } from "./export";

/** 기기에 저장된 사용자 키를 쓴다. 앱 번들에는 어떤 키도 들어가지 않는다. */
const SECURE_KEY = "anthropic.apiKey";

export async function getApiKey(): Promise<string | null> {
  const SecureStore = await import("expo-secure-store");
  return SecureStore.getItemAsync(SECURE_KEY);
}

export async function setApiKey(key: string | null): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  if (key) {
    await SecureStore.setItemAsync(SECURE_KEY, key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(SECURE_KEY);
  }
}

async function createClient(): Promise<Anthropic> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(
      "API 키가 설정되어 있지 않습니다. 설정 > 보조 기능에서 입력해 주세요. " +
        "키는 이 기기의 보안 저장소(iOS 키체인 / Android 키스토어)에만 보관됩니다.",
    );
  }
  return new Anthropic({ apiKey });
}

const MODEL = "claude-opus-5";

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

출력은 교정된 전사본 본문만. 설명이나 머리말을 붙이지 마세요.`;

/**
 * 문맥 의존 교정.
 * 규칙 기반 교정을 마친 텍스트를 입력으로 받는다. 여기서 처음 교정하지 않는다.
 */
export async function postEditTranscript(
  correctedText: string,
  lexicon: Lexicon,
): Promise<{ text: string; redactedCount: number; cacheHit: boolean }> {
  const client = await createClient();
  const redacted = await redactForNetwork(correctedText);
  const glossary = buildGlossaryForLLM(lexicon);

  const response = await client.messages.create({
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
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    text,
    redactedCount: redacted.result.redactedCount,
    cacheHit: (response.usage.cache_read_input_tokens ?? 0) > 0,
  };
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

/** 근무 통찰. 규칙으로는 뽑을 수 없는 것들. */
export async function summarizeShift(
  transcriptText: string,
  lexicon: Lexicon,
): Promise<ShiftInsight> {
  const client = await createClient();
  const redacted = await redactForNetwork(transcriptText);
  const glossary = buildGlossaryForLLM(lexicon);

  const response = await client.messages.create({
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
        input_schema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "세 문장 이내의 근무 요약" },
            followUps: {
              type: "array",
              items: { type: "string" },
              description: "다음 근무 전에 확인할 구체적 항목",
            },
            didWell: {
              type: "array",
              items: { type: "string" },
              description: "오늘 잘한 점",
            },
            studyTopics: {
              type: "array",
              items: { type: "string" },
              description: "학습이 필요한 주제",
            },
          },
          required: ["summary", "followUps", "didWell", "studyTopics"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_shift_insight" },
    messages: [{ role: "user", content: redacted.text }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
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

/** 키가 유효한지 가볍게 확인한다. 설정 화면의 "연결 테스트" 버튼용. */
export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const client = await createClient();
    await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true, message: "연결됐습니다." };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, message: "API 키가 올바르지 않습니다." };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, message: "네트워크에 연결할 수 없습니다." };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : "알 수 없는 오류",
    };
  }
}
