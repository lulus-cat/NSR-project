/**
 * ASR 모델에 도메인 지식을 주입하는 두 가지 장치를 만든다.
 *
 * ── 원리 ─────────────────────────────────────────────────────
 * Whisper는 인코더-디코더 트랜스포머다. 디코더는 매 스텝에서
 * "지금까지 나온 토큰 + 오디오 표현"을 조건으로 다음 토큰 분포를 낸다.
 * 즉 디코더는 **언어모델**이기도 하다. 그래서 앞에 어떤 텍스트가 놓여 있느냐가
 * 다음 토큰 확률을 바꾼다.
 *
 * 1) initial_prompt
 *    디코더 입력 앞에 `<|startofprev|>` 토큰과 함께 텍스트를 붙일 수 있다.
 *    여기에 용어 목록을 넣으면, 그 용어들의 토큰 시퀀스가 사전 확률상 올라간다.
 *    "노디"보다 "노티"가, "카데타"보다 "카테터"가 뽑힐 확률이 커진다.
 *    제약: 이 컨텍스트는 **224 토큰**으로 잘린다. 그래서 아무 용어나 다 넣으면 안 되고
 *    우선순위를 매겨 예산 안에 담아야 한다. 이 파일이 하는 일이 그것이다.
 *
 * 2) hotwords (faster-whisper / WhisperX 등의 구현체)
 *    디코딩 중 특정 토큰열의 로짓에 보너스를 더하는 방식(shallow fusion).
 *    initial_prompt와 달리 길이 제약이 덜하고 효과가 더 직접적이지만,
 *    과하게 주면 없는 단어를 만들어내는 부작용(hallucination)이 생긴다.
 *
 * 두 장치 모두 **완벽하지 않다**. 그래서 이 프로젝트는 여기에만 기대지 않고
 * `correct.ts`의 후처리 교정을 반드시 함께 돌린다.
 */

import type { Lexicon, LexiconEntry, TermCategory } from "../lexicon/index.js";
import { toHangulReading } from "../hangul/initialism.js";

/** initial_prompt에 들어갈 수 있는 토큰 예산. Whisper의 prev 컨텍스트 상한. */
export const WHISPER_PROMPT_TOKEN_LIMIT = 224;

/**
 * Whisper 다국어 BPE에서 한국어는 대략 음절당 1~2 토큰이다.
 * 정확한 토크나이저를 앱에 싣지 않고도 안전하게 예산을 잡기 위해
 * 한글 1자 = 1.6토큰, 그 외 = 0.4토큰으로 보수적으로 추정한다.
 */
export function estimateWhisperTokens(text: string): number {
  let total = 0;
  for (const ch of text) {
    total += /[가-힣]/.test(ch) ? 1.6 : 0.4;
  }
  return Math.ceil(total);
}

/** 카테고리별 기본 중요도. 오인식 시 위해가 큰 쪽에 높은 값을 준다. */
const CATEGORY_WEIGHT: Record<TermCategory, number> = {
  medication: 10,
  emergency: 10,
  device: 8,
  procedure: 7,
  lab: 6,
  assessment: 6,
  condition: 5,
  documentation: 5,
  workflow: 3,
  role: 2,
  shift: 2,
};

export interface PromptOptions {
  /** 이 근무에서 실제로 자주 나온 용어 id → 등장 횟수. 있으면 가중치를 크게 올린다. */
  usageCounts?: Record<string, number>;
  /** 이 부서에서 안 쓰는 카테고리는 제외한다. */
  excludeCategories?: TermCategory[];
  /** 항상 포함할 용어 id. */
  pinned?: string[];
  /** 토큰 예산. 기본 224. */
  tokenBudget?: number;
}

function score(entry: LexiconEntry, usage: Record<string, number>): number {
  const base = CATEGORY_WEIGHT[entry.category] ?? 1;
  const used = usage[entry.id] ?? 0;
  // 실제 사용 이력이 카테고리 선입견보다 강한 신호다.
  return base + Math.min(used, 20) * 3;
}

/** prompt/hotwords에 넣을 대표 표기를 고른다. 한글 표기를 우선한다. */
function promptSurface(entry: LexiconEntry): string {
  if (/[가-힣]/.test(entry.ko)) return entry.ko;
  const hangulAlias = entry.aliases.find((a) => /[가-힣]/.test(a));
  return hangulAlias ?? entry.ko;
}

/**
 * Whisper `initial_prompt` 문자열을 만든다.
 *
 * 실제 대화체 한 문장을 앞에 붙이는 이유: Whisper는 프롬프트의 **문체**도 이어받는다.
 * 용어만 나열하면 출력이 목록처럼 끊기는 경향이 생기므로,
 * 병동 대화투 한 문장으로 문맥을 잡아준 뒤 용어를 나열한다.
 *
 * 우선순위가 높은 용어를 **뒤쪽**에 배치한다. 컨텍스트가 잘릴 때 앞에서부터
 * 잘려나가므로, 뒤에 있을수록 살아남는다.
 */
export function buildInitialPrompt(
  lexicon: Lexicon,
  options: PromptOptions = {},
): string {
  const budget = options.tokenBudget ?? WHISPER_PROMPT_TOKEN_LIMIT;
  const usage = options.usageCounts ?? {};
  const excluded = new Set(options.excludeCategories ?? []);
  const pinned = new Set(options.pinned ?? []);

  const preamble = "간호사 인계 대화입니다.";

  const ranked = lexicon.entries
    .filter((e) => pinned.has(e.id) || !excluded.has(e.category))
    .map((e) => ({
      entry: e,
      s: pinned.has(e.id) ? 1000 : score(e, usage),
    }))
    .sort((a, b) => a.s - b.s); // 낮은 것부터 → 높은 것이 뒤에 남는다

  const chosen: string[] = [];
  let used = estimateWhisperTokens(preamble);
  // 뒤(=고우선순위)부터 채우고 마지막에 뒤집어 붙인다.
  for (let i = ranked.length - 1; i >= 0; i--) {
    const surface = promptSurface(ranked[i].entry);
    const cost = estimateWhisperTokens(surface) + 1; // 구분자 몫
    if (used + cost > budget) break;
    used += cost;
    chosen.push(surface);
  }
  chosen.reverse();

  return `${preamble} ${chosen.join(", ")}`.trim();
}

/**
 * faster-whisper `hotwords`용 목록.
 * initial_prompt보다 길이에 여유가 있지만, 무한정 넣으면 오히려 오인식이 늘어난다.
 * 기본 상한을 두고, 사용 이력이 있는 용어를 우선한다.
 */
export function buildHotwords(
  lexicon: Lexicon,
  options: PromptOptions & { limit?: number } = {},
): string[] {
  const usage = options.usageCounts ?? {};
  const excluded = new Set(options.excludeCategories ?? []);
  const limit = options.limit ?? 120;
  return lexicon.entries
    .filter((e) => !excluded.has(e.category))
    .map((e) => ({ entry: e, s: score(e, usage) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => promptSurface(r.entry));
}

/**
 * 상용 한국어 STT의 키워드 부스팅용 목록.
 *
 * Whisper와 무엇이 다른가
 * ----------------------
 * `initial_prompt`는 Whisper 고유의 장치다. 디코더 앞에 텍스트를 붙여 언어모델
 * 사전확률을 바꾸는 것이고, 224토큰 상한이 있다.
 *
 * 국내 상용 엔진(네이버 클로바 등)은 Whisper 기반이 아니다. 대신 **키워드 부스팅**이라는
 * 자기 장치를 갖고 있다. 특정 단어의 인식 확률에 가중치를 주는 방식이고,
 * 상한이 훨씬 넉넉하다(클로바 기준 1,000개).
 *
 * 두 가지를 지켜야 한다.
 *
 *  1. **한글만 넣는다.** 클로바의 키워드 부스팅은 한국어만 받는다. 그리고 애초에
 *     한국어 오디오에 "ABGA"라는 소리는 존재하지 않는다 — 사람은 "에이비지에이"라고
 *     발음한다. 그래서 약어는 `toHangulReading`으로 읽기형을 만들어 넣는다.
 *  2. **가중치를 함부로 높이지 않는다.** 세게 주면 없는 단어를 만들어낸다.
 *     실제 사용 이력이 있는 용어에만 조금 더 준다.
 */
export interface BoostingKeyword {
  keyword: string;
  /** 가중치. 엔진마다 범위가 다르므로 호출부에서 매핑한다. 여기서는 1~3. */
  weight: number;
}

export function buildKeywordBoosting(
  lexicon: Lexicon,
  options: PromptOptions & { limit?: number } = {},
): BoostingKeyword[] {
  const usage = options.usageCounts ?? {};
  const excluded = new Set(options.excludeCategories ?? []);
  const limit = options.limit ?? 1000;

  const seen = new Set<string>();
  const out: BoostingKeyword[] = [];

  const ranked = lexicon.entries
    .filter((e) => !excluded.has(e.category))
    .map((e) => ({ entry: e, s: score(e, usage) }))
    .sort((a, b) => b.s - a.s);

  for (const { entry } of ranked) {
    if (out.length >= limit) break;
    // 실제로 소리 나는 형태만. 한글이 아닌 것은 오디오에 존재하지 않는다.
    const forms: string[] = [];
    if (/[가-힣]/.test(entry.ko)) forms.push(entry.ko);
    for (const alias of entry.aliases) {
      if (/[가-힣]/.test(alias)) forms.push(alias);
    }
    if (entry.abbr) {
      const reading = toHangulReading(entry.abbr);
      if (reading) forms.push(reading);
    }

    // 사용 이력이 쌓인 용어에만 가중치를 올린다. 기본은 1.
    const used = usage[entry.id] ?? 0;
    const weight = used >= 10 ? 3 : used >= 3 ? 2 : 1;

    for (const form of forms) {
      if (out.length >= limit) break;
      if (seen.has(form)) continue;
      seen.add(form);
      out.push({ keyword: form, weight });
    }
  }
  return out;
}

/**
 * LLM 후편집(post-editing)용 용어집.
 * 후처리 규칙으로 잡히지 않는 문맥 의존 오류 - 예를 들어 "디씨"가
 * discharge인지 discontinue인지 - 는 규칙으로 못 푼다. 문맥을 보는 모델이 필요하다.
 * 그 모델에게 줄 참고 자료를 만든다.
 *
 * 이 문자열은 **요청마다 바뀌지 않는다**. 그래서 프롬프트 캐시의 안정 접두부로 두면
 * 매 요청 비용이 크게 떨어진다 (client.ts 참고).
 */
export function buildGlossaryForLLM(lexicon: Lexicon): string {
  const lines: string[] = [];
  for (const e of lexicon.entries) {
    const forms = [e.ko, e.abbr, e.en].filter(Boolean).join(" / ");
    const alias = e.aliases.slice(0, 6).join(", ");
    const flag = e.informal ? ` [은어 → 공식: ${e.formal}]` : "";
    lines.push(`- ${forms}${flag} | 변이형: ${alias} | ${e.definition}`);
  }
  // id 순으로 정렬해 출력이 결정적이도록 만든다. 순서가 흔들리면 캐시가 깨진다.
  lines.sort();
  return lines.join("\n");
}
