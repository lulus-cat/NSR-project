/**
 * 전사본 검토 — 사람이 봐야 할 후보를 골라낸다.
 *
 * `correct.ts` 는 확실한 것만 고친다. 그게 맞다 — 전사본은 증거라서 애매한 것을 기계가
 * 바꾸면 안 된다. 그런데 애매한 것을 **버려서도 안 된다.** "석숀" 은 교정 문턱(0.9)에
 * 못 미쳐 그대로 남지만, 읽는 사람은 그것이 석션인지 알아야 한다.
 *
 * 그래서 이 모듈은 교정기 위에 한 층을 더 얹어, 문장마다 후보를 세 묶음으로 나눈다.
 *
 *   auto   기계가 고쳤고 근거가 확실한 것 (사전 오인식·약어 읽기·사용자 확정 이력)
 *   check  기계가 고쳤지만 사람이 한 번 봐야 하는 것 (발음 매칭 신뢰도가 애매, 뜻이 갈리는 약어)
 *   ask    기계는 손대지 않았고 사람에게 물어야 하는 것 (반복 환각, 문턱 미만 유사어, 모르는 약어)
 *
 * 휘스퍼가 틀리는 세 갈래(반복 환각 / 임상 어휘 부재 / 한글 오독)의 **최종 판정은 사람 또는
 * 문맥을 읽는 모델이 한다.** 여기서는 그 판정에 필요한 후보와 근거를 빠짐없이 모아 줄 뿐이다.
 * 판정 절차는 `.claude/skills/nsr-transcript-review/SKILL.md` 에 있다.
 *
 * 문장 단위로 도는 이유: 질문에 "어느 문장인지"를 붙여야 사람이 녹음의 그 지점을 찾는다.
 */

import type { CorrectionOptions } from "./correct.js";
import { correctTranscript } from "./correct.js";
import { splitSentences } from "./sentences.js";
import type { Lexicon, LexiconEntry } from "../lexicon/index.js";
import { ALL_ABBREVS, defaultLexicon, spokenSurfacesOf } from "../lexicon/index.js";
import { phoneticSimilarity } from "../hangul/similarity.js";
import { expandInitialism } from "../hangul/initialism.js";

/* ── 반복 환각 ─────────────────────────────────────────────── */

export interface RepetitionSpan {
  /** 입력 문자열 기준 위치. */
  start: number;
  end: number;
  /** 반복된 단위. 어절 여러 개면 공백으로 이어 붙인 것. */
  unit: string;
  /** 연속 반복 횟수. */
  count: number;
}

export interface RepetitionOptions {
  /** 이 횟수 이상 연속되어야 잡는다. 기본 3 — "네 네" 는 실제 발화다. */
  minRepeats?: number;
  /** 반복 단위의 최대 어절 수. 기본 6. */
  maxUnitWords?: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    out.push({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

const PUNCT = /^[.,!?~"'()[\]{}·…:;]+|[.,!?~"'()[\]{}·…:;]+$/g;

function bare(text: string): string {
  return text.replace(PUNCT, "");
}

/** tokens[j..j+n) 이 tokens[i..i+n) 과 같은가. 문장부호는 무시한다. */
function sameRun(tokens: Token[], i: number, j: number, n: number): boolean {
  if (j + n > tokens.length) return false;
  for (let k = 0; k < n; k++) {
    if (bare(tokens[i + k].text) !== bare(tokens[j + k].text)) return false;
  }
  return true;
}

/** 어절 안에서 붙어 반복된 것. "감사합니다감사합니다감사합니다" */
function innerRepeat(
  word: string,
  minRepeats: number,
): { offset: number; length: number; unit: string; count: number } | null {
  const re = new RegExp(`(.{1,12}?)\\1{${minRepeats - 1},}`, "u");
  const m = re.exec(word);
  if (!m || m.index === undefined) return null;
  const unit = m[1];
  return { offset: m.index, length: m[0].length, unit, count: m[0].length / unit.length };
}

/**
 * 같은 어절·구가 연속으로 되풀이되는 구간을 찾는다.
 *
 * Whisper 는 무음·잡음 구간에서 앞 문맥에 갇혀 같은 말을 반복 생성한다.
 * 그런데 사람도 "네 네" 정도는 실제로 말하므로 기본 3회부터 잡고, 판정은 사람에게 넘긴다.
 * 여러 길이의 단위가 동시에 걸리면 **덮는 어절 수가 가장 많은 것**을 고른다.
 */
export function findRepetitions(
  text: string,
  options: RepetitionOptions = {},
): RepetitionSpan[] {
  const minRepeats = options.minRepeats ?? 3;
  const maxUnit = options.maxUnitWords ?? 6;
  const tokens = tokenize(text);
  const out: RepetitionSpan[] = [];

  let i = 0;
  while (i < tokens.length) {
    let best: { n: number; count: number } | null = null;
    for (let n = 1; n <= maxUnit && i + n <= tokens.length; n++) {
      let count = 1;
      while (sameRun(tokens, i, i + count * n, n)) count++;
      if (count >= minRepeats && (!best || count * n > best.count * best.n)) {
        best = { n, count };
      }
    }
    if (best) {
      const last = tokens[i + best.n * best.count - 1];
      out.push({
        start: tokens[i].start,
        end: last.end,
        unit: tokens.slice(i, i + best.n).map((t) => t.text).join(" "),
        count: best.count,
      });
      i += best.n * best.count;
      continue;
    }
    const inner = innerRepeat(bare(tokens[i].text), minRepeats);
    if (inner) {
      const lead = tokens[i].text.length - tokens[i].text.replace(/^[.,!?~"'()[\]{}·…:;]+/, "").length;
      const start = tokens[i].start + lead + inner.offset;
      out.push({ start, end: start + inner.length, unit: inner.unit, count: inner.count });
    }
    i++;
  }
  return out;
}

/* ── 검토 항목 ─────────────────────────────────────────────── */

export type ReviewVerdict = "auto" | "check" | "ask";

export type ReviewKind =
  /** 사전에 등록된 오인식 표기 → 교정됨 */
  | "misheard"
  /** 한글로 읽은 영문 약어 → 표기 변환됨 */
  | "initialism"
  /** 사용자가 전에 확정한 교정 → 적용됨 */
  | "learned"
  /** 발음 유사 매칭으로 교정됨. 신뢰도에 따라 auto/check */
  | "phonetic"
  /** 표기는 맞지만 문맥에 따라 뜻이 갈리는 약어 (D/C 등) */
  | "ambiguous"
  /** 같은 말이 연속 반복 — 환각 의심 */
  | "repetition"
  /** 교정 문턱에는 못 미치지만 사전 용어와 발음이 가까운 말 */
  | "unknown-term"
  /** 알파벳 읽기로 풀리지만 사전에 없는 약어 */
  | "unknown-initialism";

export interface ReviewItem {
  verdict: ReviewVerdict;
  kind: ReviewKind;
  /** 원문 표기. */
  surface: string;
  /** 제안 표기. ambiguous 는 없을 수 있다 (표기는 맞고 뜻만 확정하면 된다). */
  suggestion?: string;
  entryId?: string;
  /** 0~1. */
  confidence: number;
  /** 이 항목이 들어 있는 원문 문장. */
  sentence: string;
  /** `ReviewResult.sentences` 의 색인. */
  sentenceIndex: number;
  /** 사람이 읽는 한 줄 근거. */
  reason: string;
}

export interface ReviewOptions extends CorrectionOptions {
  /** 발음 매칭 교정 중 이 값 이상이면 auto, 미만이면 check. 기본 0.95. */
  autoThreshold?: number;
  /**
   * 사전 용어와 이 값 이상 가까우면 ask 후보로 올린다. 기본 0.78.
   * 2음절 후보는 우연히 걸릴 확률이 높아 0.84 이상을 요구한다
   * (석숀↔석션 0.84, 인케↔인계 0.88 은 잡고, 노트↔노티 0.76 은 안 잡는 선).
   */
  askThreshold?: number;
  repetition?: RepetitionOptions;
}

export interface ReviewedSentence {
  raw: string;
  text: string;
  /** 원문 전체 기준 위치. */
  start: number;
  end: number;
}

export interface ReviewResult {
  original: string;
  /** 문장별 교정본을 원문 순서대로 이어 붙인 것. */
  text: string;
  sentences: ReviewedSentence[];
  items: ReviewItem[];
}

function abbrKey(abbr: string): string {
  return abbr.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 문맥에 따라 뜻이 갈리는 약어 (abbreviations.ts 의 ambiguous 표시). */
const AMBIGUOUS_ABBR: ReadonlySet<string> = new Set(
  ALL_ABBREVS.filter((r) => r.ambiguous).map((r) => abbrKey(r.abbr)),
);

/** 항목의 표기 중 입력과 발음이 가장 가까운 한글 표기. */
function closestHangulSurface(entry: LexiconEntry, surface: string): string {
  const candidates = spokenSurfacesOf(entry).filter((s) => /[가-힣]/.test(s));
  let best = candidates[0] ?? entry.ko;
  let bestScore = -1;
  for (const c of candidates) {
    const s = phoneticSimilarity(surface, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/**
 * 병동 대화에 흔한 일반어. 사전 용어와 발음이 우연히 가까워도("내일"↔"레일", "연락"↔"열남")
 * 사용자에게 묻지 않고 **확인 목록**에만 둔다. 문맥이 임상 용어를 요구하는 자리라면
 * 문맥을 읽는 쪽(사람·모델)이 거기서 잡는다. 여기서 버리지는 않는다 — 판정만 낮춘다.
 */
const COMMON_WORDS: ReadonlySet<string> = new Set(
  (
    "오늘 내일 어제 모레 지금 아까 이따 나중 먼저 다음 처음 마지막 시간 아침 점심 저녁 오전 오후 새벽 " +
    "주말 평일 연락 전화 문자 확인 정리 준비 시작 마무리 다시 계속 그냥 정말 진짜 완전 조금 많이 약간 " +
    "거의 전부 항상 가끔 자주 이거 저거 그거 여기 저기 거기 우리 저희 선생님 언니 누구 무엇 어디 언제 " +
    "어떻게 얼마 사람 생각 말씀 이야기 얘기 부탁 감사 죄송 미안 괜찮 안녕 수고 고생 걱정 문제 이유 방법 " +
    "경우 상황 정도 이상 이하 이후 이전 동안 사이 근처 때문 위해 대해 통해 관련 포함 제외 결과 내용 " +
    "자료 파일 사진 영상 목록 이름 번호 주소 나이 남자 여자 아이 어른 가족 부모 엄마 아빠 친구 동생 " +
    "오빠 누나 집에 회사 학교 식당 화장실 커피 과일 우리가 그래서 그러면 그런데 그리고 하지만 근데 " +
    "일단 아마 혹시 만약 역시 물론 특히 바로 벌써 아직 이미 금방 천천히 빨리 잠깐 잠시 오래 매일 " +
    "이번 저번 다음주 이번주 지난주 요즘 최근 원래 보통 가끔씩 자꾸 계속해서 그때 이때 저때 언제나"
  ).split(/\s+/),
);

function isCovered(word: string, covered: ReadonlySet<string>): boolean {
  for (const s of covered) {
    if (!s) continue;
    if (word.includes(s) || s.includes(word)) return true;
  }
  return false;
}

/**
 * 교정기가 손대지 않은 어절 중에서 사람이 봐야 할 것을 찾는다.
 *   - 알파벳 읽기로 풀리는데 사전에 없는 약어 (3음절 이상 — "이에", "아이" 같은 일반어를 피한다)
 *   - 사전 용어와 발음이 가깝지만 교정 문턱에 못 미친 말
 */
function findUnknownCandidates(
  sentence: string,
  lexicon: Lexicon,
  covered: ReadonlySet<string>,
  thresholds: { ask: number; minPhonetic: number },
  base: { sentence: string; sentenceIndex: number },
): ReviewItem[] {
  const out: ReviewItem[] = [];
  const seen = new Set<string>();

  for (const tok of tokenize(sentence)) {
    const word = bare(tok.text);
    if (!/[가-힣]{2,}/.test(word)) continue;
    if (isCovered(word, covered)) continue;

    let best: ReviewItem | null = null;
    const maxTrim = Math.min(3, word.length - 2);
    for (let trim = 0; trim <= maxTrim; trim++) {
      const cand = word.slice(0, word.length - trim);
      if (!/^[가-힣]{2,}$/.test(cand)) continue;

      if (cand.length >= 3) {
        const readings = expandInitialism(cand).filter((r) => r.length >= 2);
        if (readings.length > 0) {
          const known = readings.some((r) => lexicon.knownAbbreviations.has(r));
          if (!known) {
            best = {
              ...base,
              verdict: "ask",
              kind: "unknown-initialism",
              surface: cand,
              suggestion: readings.slice(0, 4).join(" / "),
              confidence: 0.5,
              reason: `알파벳 읽기로 풀리지만(${readings[0]}) 사전에 없는 약어 — 병원 고유 약어이거나 오인식`,
            };
            break;
          }
        }
      }

      const hit = lexicon.lookup(cand, thresholds.ask);
      if (!hit || hit.via !== "phonetic" || hit.confidence >= thresholds.minPhonetic) continue;
      const required = cand.length <= 2 ? Math.max(thresholds.ask, 0.84) : thresholds.ask;
      if (hit.confidence < required) continue;
      if (best && best.confidence >= hit.confidence) continue;
      const common = COMMON_WORDS.has(cand);
      best = {
        ...base,
        verdict: common ? "check" : "ask",
        kind: "unknown-term",
        surface: cand,
        suggestion: closestHangulSurface(hit.entry, cand),
        entryId: hit.entry.id,
        confidence: hit.confidence,
        reason: common
          ? `흔한 일반어 — 사전 용어 "${hit.entry.ko}" 와 발음 ${hit.confidence.toFixed(2)} 로 가깝지만, 문맥이 그 용어를 요구할 때만 오인식으로 본다`
          : `사전 용어 "${hit.entry.ko}" 와 발음 유사도 ${hit.confidence.toFixed(2)} — 교정 문턱(${thresholds.minPhonetic}) 미만이라 손대지 않음`,
      };
    }
    if (best && !seen.has(best.surface)) {
      seen.add(best.surface);
      out.push(best);
    }
  }
  return out;
}

/**
 * 전사 텍스트 한 덩어리를 문장 단위로 교정하고, 사람이 볼 후보를 모은다.
 */
export function reviewTranscript(raw: string, options: ReviewOptions = {}): ReviewResult {
  const lexicon = options.lexicon ?? defaultLexicon;
  const autoThreshold = options.autoThreshold ?? 0.95;
  const askThreshold = options.askThreshold ?? 0.78;
  const minPhonetic = options.minPhoneticConfidence ?? 0.9;

  const sentences: ReviewedSentence[] = [];
  const items: ReviewItem[] = [];
  let text = "";
  let pos = 0;

  splitSentences(raw).forEach((span, sentenceIndex) => {
    const result = correctTranscript(span.text, { ...options, lexicon });
    text += raw.slice(pos, span.start) + result.text;
    pos = span.end;
    sentences.push({ raw: span.text, text: result.text, start: span.start, end: span.end });

    const base = { sentence: span.text, sentenceIndex };

    for (const e of result.edits) {
      const common = { ...base, surface: e.from, suggestion: e.to, confidence: e.confidence };
      if (e.entryId) Object.assign(common, { entryId: e.entryId });
      switch (e.reason) {
        case "learned":
          items.push({ ...common, verdict: "auto", kind: "learned", reason: "사용자가 전에 확정한 교정" });
          break;
        case "misheard":
          items.push({ ...common, verdict: "auto", kind: "misheard", reason: "사전에 등록된 오인식 표기" });
          break;
        case "initialism":
          items.push({ ...common, verdict: "auto", kind: "initialism", reason: "한글로 읽은 영문 약어를 표기만 바꿈" });
          break;
        case "phonetic": {
          const auto = e.confidence >= autoThreshold;
          items.push({
            ...common,
            verdict: auto ? "auto" : "check",
            kind: "phonetic",
            reason: auto
              ? `발음 유사도 ${e.confidence.toFixed(2)}`
              : `발음 유사도 ${e.confidence.toFixed(2)} — 짧거나 애매해 확인 필요`,
          });
          break;
        }
      }
    }

    for (const a of result.annotations) {
      const entry = lexicon.get(a.entryId);
      if (!entry?.abbr || !AMBIGUOUS_ABBR.has(abbrKey(entry.abbr))) continue;
      items.push({
        ...base,
        verdict: "check",
        kind: "ambiguous",
        surface: a.surface,
        entryId: a.entryId,
        confidence: a.confidence,
        reason: `${entry.abbr} 는 문맥에 따라 뜻이 갈리는 약어 — 앞뒤 문장으로 뜻을 확정할 것`,
      });
    }

    for (const r of findRepetitions(span.text, options.repetition)) {
      items.push({
        ...base,
        verdict: "ask",
        kind: "repetition",
        surface: span.text.slice(r.start, r.end),
        suggestion: r.unit,
        confidence: Math.min(1, 0.5 + (r.count - 3) * 0.1),
        reason: `"${r.unit}" ${r.count}회 연속 — 무음·잡음 구간의 반복 환각일 수 있음. 실제 발화인지 그 시각을 들어 확인`,
      });
    }

    const covered = new Set<string>([
      ...result.annotations.map((a) => a.surface),
      ...result.edits.map((e) => e.from),
    ]);
    items.push(
      ...findUnknownCandidates(span.text, lexicon, covered, { ask: askThreshold, minPhonetic }, base),
    );
  });
  text += raw.slice(pos);

  return { original: raw, text, sentences, items };
}
