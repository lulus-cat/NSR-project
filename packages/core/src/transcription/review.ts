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
import { correctTranscript, looksLikeTail } from "./correct.js";
import { splitSentences } from "./sentences.js";
import type { Lexicon, LexiconEntry } from "../lexicon/index.js";
import { ALL_ABBREVS, COMMON_WORDS, defaultLexicon, spokenSurfacesOf } from "../lexicon/index.js";
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
  // 한글이 아닌 반복("ccc", "xxx")은 약어일 수 있다. 말의 반복만 본다.
  if (!/[가-힣]/.test(unit)) return null;
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
   * 사전 용어와 이 값 이상 가까우면 ask 후보로 올린다. 기본 0.78 (카데타↔카테터 0.79 를 잡는 선).
   * 3음절 이상만 본다 — 2음절은 우연이 태반이다 (findUnknownCandidates 머리말).
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

// 흔한 일반어 목록은 교정기와 공유한다 (lexicon/common-words.ts). 교정기는 거기 있는 말을
// 발음 매칭으로 덮어쓰지 않고, 여기서는 사용자에게 묻지 않고 "확인" 으로만 낮춘다.

function isCovered(word: string, covered: ReadonlySet<string>): boolean {
  for (const s of covered) {
    if (!s) continue;
    if (word.includes(s) || s.includes(word)) return true;
  }
  return false;
}

/**
 * 용언 어미로 흔히 끝나는 글자. 후보의 끝이 이것인데 사전 용어의 끝과 다르면, 어미까지
 * 세어야 겨우 비슷해진 우연이다 ("휴식이"↔"표시기", "얘네만"↔"에네마", "그러니"↔"그레이").
 * 조사 목록(correct.ts 의 looksLikeTail)에 어미를 더한 것이다.
 */
const VERB_ENDINGS: ReadonlySet<string> = new Set(
  (
    "니 데 든 던 고 서 면 며 지 게 어 아 자 죠 네 나 까 걸 긴 는 은 을 라 러 려 냐 뇨 군 " +
    "더 놔 녀 봐 줘 워 와 져 쳐 떠 퍼 뭐 돼 대 래 케 세 테 셔 셨 겠 았 었 였 " // 아니더·올려놔·피아녀
  ).split(/\s+/),
);

function endsLikeEnding(word: string): boolean {
  const last = word[word.length - 1];
  return looksLikeTail(last) || VERB_ENDINGS.has(last);
}

/** 한글 표기가 알파벳 읽기로 풀리는가 ("디씨", "알알", "에이피"). */
function readsLikeAbbr(surface: string): boolean {
  return expandInitialism(surface.replace(/\s+/g, "")).some((r) => r.length >= 2);
}

/**
 * 교정기가 손대지 않은 어절 중에서 사람이 봐야 할 것을 찾는다.
 *   - 알파벳 읽기로 풀리는데 사전에 없는 약어 (3음절 이상 — "이에", "아이" 같은 일반어를 피한다)
 *   - 사전 용어와 발음이 가깝지만 교정 문턱에 못 미친 말
 *
 * 정밀도를 위해 세 가지를 요구한다 (7,500문장짜리 실제 파일에서 배운 것):
 *   - 후보도 사전 표기도 **3음절 이상**. 2음절은 "차례"↔"사레", "보니"↔"폴리" 처럼 우연이 태반이다.
 *     2음절 오인식은 사전의 misheard 목록과 문맥을 읽는 사람이 맡는다.
 *   - 후보의 끝이 조사·어미 글자면 사전 표기도 같은 글자로 끝나야 한다.
 *   - 흔한 일반어는 아예 보지 않는다.
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
    // 긴 어절은 용어+조사가 아니라 용언·구다. 사전 용어는 길어야 6~7음절이다.
    if (word.length > 8) continue;
    if (isCovered(word, covered)) continue;
    // 흔한 일반어는 사전 용어와 발음이 우연히 가까워도 후보로 올리지 않는다.
    // 화자가 실제로 그렇게 말했을 확률이 압도적이고, 긴 파일에서 잡음만 만든다.
    if (COMMON_WORDS.has(word)) continue;

    let best: ReviewItem | null = null;
    const maxTrim = Math.min(3, word.length - 2);
    for (let trim = 0; trim <= maxTrim; trim++) {
      // 꼬리가 조사·어미처럼 생기지 않았으면 낱말의 일부다 — 교정기와 같은 규칙.
      if (trim > 0 && !looksLikeTail(word.slice(word.length - trim))) continue;
      const cand = word.slice(0, word.length - trim);
      if (!/^[가-힣]{2,}$/.test(cand)) continue;
      if (COMMON_WORDS.has(cand)) continue;

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

      if (cand.length < 3) continue;
      // 마지막 글자를 뗀 줄기가 흔한 말이면 조사가 붙은 일반어다 ("사람이", "카드만").
      if (COMMON_WORDS.has(cand.slice(0, -1))) continue;
      const hit = lexicon.lookup(cand, thresholds.ask);
      if (!hit || hit.via !== "phonetic") continue;
      // 교정기가 이미 고쳤을 구간(문턱 이상)은 건너뛴다.
      if (hit.confidence >= thresholds.minPhonetic) continue;
      if (hit.confidence < thresholds.ask) continue;
      const suggestion = closestHangulSurface(hit.entry, cand);
      if (suggestion.length < 3) continue;
      if (endsLikeEnding(cand) && suggestion[suggestion.length - 1] !== cand[cand.length - 1]) continue;
      // 약어의 한글 읽기(피이지·알아이·피이티)는 어미로 끝나는 우리말과 잘 겹친다
      // ("보이지"↔"피이지", "사람이"↔"알아이"). 후보가 어미로 끝나면 약어 읽기와는 맞추지 않는다.
      if (hit.entry.id.startsWith("abbr-") && endsLikeEnding(cand)) continue;
      if (best && best.confidence >= hit.confidence) continue;
      best = {
        ...base,
        verdict: "ask",
        kind: "unknown-term",
        surface: cand,
        suggestion,
        entryId: hit.entry.id,
        confidence: hit.confidence,
        reason: `사전 용어 "${hit.entry.ko}" 와 발음 유사도 ${hit.confidence.toFixed(2)} — 교정 문턱 미만이라 손대지 않음`,
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
      // "호흡" 처럼 한국어 표제어를 그대로 말한 것은 뜻이 갈리지 않는다. 약어(D/C)나
      // 약어 읽기(디씨·알알)로 말했을 때만 어느 뜻인지 확정할 일이 생긴다.
      if (a.surface === entry.ko || /[가-힣]/.test(a.surface) && !readsLikeAbbr(a.surface)) continue;
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
