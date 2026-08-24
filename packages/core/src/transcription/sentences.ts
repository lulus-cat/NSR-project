/**
 * 전사본을 문장 단위로 나눈다.
 *
 * 왜 나눠야 하는가
 * --------------
 * Whisper 가 뱉는 세그먼트는 문장이 아니라 **30초짜리 덩어리**다. VAD 를 켜면
 * 무음 기준으로 잘리지만 그것도 문장 경계와는 상관이 없다. 그래서 한 덩어리 안에
 * 이런 것이 통째로 들어간다.
 *
 *   "네 그럼 인계 시작할게요 301호 김OO님 어제 수술하셨고 오늘 아침에 열 났어요
 *    노티했는데 일단 지켜보자고 하셨어요 폴리 유지 중이고 소변량 괜찮아요"
 *
 * 이 상태면 아무것도 제대로 안 붙는다.
 *   - 화자가 중간에 바뀌어도 한 덩어리라 나눌 수가 없다
 *   - 한 문장만 고치고 싶은데 덩어리 전체를 고쳐야 한다
 *   - 학습카드의 예문이 문단째로 들어간다
 *   - 태움 판정에서 인용이 통째로 나와 어디가 문제인지 안 보인다
 *
 * 한국어에서 문장 끝을 어떻게 아는가
 * ------------------------------
 * 문장부호가 있으면 쉽다. 그런데 말한 것을 받아적은 것이라 부호가 없는 경우가 많다.
 * 그래서 **종결어미**를 본다. -다, -요, -까, -죠, -네, -군, -자, -라 …
 *
 * 여기서 흔히 틀리는 지점이 있다. "했다고 했어요" 의 '했다' 는 종결어미처럼 보이지만
 * 문장 끝이 아니다. 이걸 형태소 분석 없이 어떻게 가리는가?
 *
 *   **어절 끝만 본다.**
 *
 * "했다고 했어요" 를 띄어쓰기로 자르면 ["했다고", "했어요"] 다. 첫 어절의 끝은
 * '고'이지 '다'가 아니다. 연결어미는 같은 어절 안에서 종결어미 뒤에 붙기 때문에,
 * 어절 끝만 보면 **연결어미가 저절로 걸러진다.** 형태소 분석기 없이 이만큼 온다.
 *
 * 남는 애매함
 * ---------
 * "환자분이 아프다 하셔서" 처럼 인용조사 '고' 없이 이어지는 말은 못 가린다.
 * 이건 말로 할 때 실제로 자주 나온다. 그래서 다음 어절이 '하-', '그러-', '라고'
 * 같은 이어받는 말로 시작하면 자르지 않는다. 완벽하지 않다.
 *
 * 애매하면 **자르지 않는 쪽**을 고른다. 덜 자른 문장은 조금 불편할 뿐이지만,
 * 잘못 자른 문장은 뜻이 바뀌고 인용으로 쓸 때 사람을 오해하게 만든다.
 */

import type { TranscriptSegment } from "./types.js";

/** 문장을 끝내는 부호. */
const TERMINAL_PUNCT = /[.!?…]+$/;

/**
 * 어절 끝에 오면 문장이 끝났다고 볼 종결어미.
 *
 * 한 글자짜리는 아무거나 넣으면 안 된다
 * ----------------------------------
 * 처음에는 -지, -자, -네, -라, -니 까지 다 넣었다가 바로 깨졌다.
 * 한국어에서 흔한 **명사들이 그 글자로 끝나기 때문**이다.
 *
 *   "유지"의 끝은 '지'  → "폴리 유지 / 중이에요" 로 잘렸다
 *   "환자"의 끝은 '자'  → "환자" 뒤에서 문장이 끊긴다
 *   "교대"의 끝은 '대', "병동"은 아니지만 "어머니"의 끝은 '니'
 *
 * 그래서 한 글자로 받는 것은 **-다 -요 -까 -죠** 넷만 남겼다. 이 넷도
 * "필요", "중요" 같은 예외가 있어 아래 NOT_FINAL 로 걸러낸다.
 *
 * 그 대신 -네, -지, -군, -자(청유) 로 끝나는 문장은 안 잘린다.
 * 덜 자르는 쪽을 고른 결과다 — 덜 자른 문장은 조금 불편할 뿐이지만,
 * 잘못 자른 문장은 뜻이 바뀐다.
 */
const FINAL_ENDINGS = [
  // 두 글자 이상. 이쪽은 오탐이 거의 없다.
  "십시오", "습니까", "니다", // 니다 하나로 "합니다"와 "습니다"를 다 받는다
  "인데요", "는데요",
  // 한 글자. NOT_FINAL 로 예외를 뺀다.
  "다", "요", "까", "죠",
];

/**
 * 위 한 글자 어미에 걸리지만 문장 끝이 아닌 말들.
 * 병동에서 실제로 자주 나오는 것만 넣는다. 늘려야 할 일이 생기면 늘린다.
 */
const NOT_FINAL = new Set([
  "필요", "중요", "소요", "수요", "주요", "개요", "요요",
  "바다", "사이다", "소다", "이다가", "보다",
]);

/**
 * 이 말로 시작하는 어절이 뒤따르면 앞에서 자르지 않는다.
 *
 * "아프다 하셔서", "많다 그래서" 처럼 인용조사 없이 이어지는 말들이다.
 * 이걸 안 두면 한 문장이 둘로 쪼개져 뜻이 뒤집힌다.
 */
const CONTINUATION_STARTERS = [
  "하셔서", "하셔도", "하시고", "하시면", "하셨", "하셔",
  "하고", "하는", "하면", "해서", "했", "한다고", "하네",
  "그래서", "그러니까", "그러면", "그런데", "그리고", "그랬",
  "라고", "라는", "라며", "고요", "고", "며", "면서",
];

/** 문장 하나. 원본 문자열 안에서의 위치를 함께 들고 있는다. */
export interface SentenceSpan {
  text: string;
  /** 원본 문자열 기준 시작 위치(포함). */
  start: number;
  /** 원본 문자열 기준 끝 위치(제외). */
  end: number;
}

function endsWithFinalEnding(eojeol: string): boolean {
  const bare = eojeol.replace(/["'”’)\]}]+$/, "");
  if (bare.length === 0) return false;
  if (NOT_FINAL.has(bare)) return false;
  return FINAL_ENDINGS.some((e) => bare.endsWith(e));
}

function startsWithContinuation(eojeol: string): boolean {
  const bare = eojeol.replace(/^["'“‘([{]+/, "");
  return CONTINUATION_STARTERS.some((c) => bare.startsWith(c));
}

/**
 * 문장으로 나눈다. 원본 글자는 하나도 잃지 않는다.
 *
 * 반환된 span 들의 text 를 이어 붙이면(사이 공백 포함) 원본이 된다 —
 * 이 성질이 깨지면 화면의 하이라이트 위치와 교정 위치가 전부 어긋난다.
 */
export function splitSentences(input: string): SentenceSpan[] {
  const text = input;
  if (text.trim().length === 0) return [];

  // 어절과 그 위치를 모은다.
  const eojeols: { text: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  for (const m of text.matchAll(re)) {
    eojeols.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (eojeols.length === 0) return [];

  const spans: SentenceSpan[] = [];
  let sentenceStart = eojeols[0].start;

  for (let i = 0; i < eojeols.length; i++) {
    const cur = eojeols[i];
    const next = eojeols[i + 1];
    const isLast = i === eojeols.length - 1;

    let boundary = false;
    if (TERMINAL_PUNCT.test(cur.text)) {
      // 부호가 있으면 그것만으로 충분하다. 종결어미를 따로 볼 필요가 없다.
      boundary = true;
    } else if (endsWithFinalEnding(cur.text)) {
      // 뒤에 이어받는 말이 오면 문장이 안 끝난 것이다.
      boundary = !next || !startsWithContinuation(next.text);
    }

    if (boundary || isLast) {
      spans.push({
        text: text.slice(sentenceStart, cur.end),
        start: sentenceStart,
        end: cur.end,
      });
      if (next) sentenceStart = next.start;
    }
  }

  return spans;
}

// ────────────────────────────────────────────────────────────
//  세그먼트 나누기
// ────────────────────────────────────────────────────────────

export interface SplitSegmentOptions {
  /**
   * 이보다 짧은 문장은 앞 문장에 붙인다(글자 수).
   * "네", "아 네네" 같은 맞장구가 문장 하나씩 차지하면 목록이 못 쓰게 된다.
   */
  minChars?: number;
}

/**
 * 세그먼트 하나를 문장 세그먼트 여러 개로 나눈다.
 *
 * 시각은 어떻게 나누는가
 * -------------------
 * 문장별 정확한 시각은 알 수 없다. Whisper 가 주는 것은 세그먼트 단위 시각이고,
 * 단어 단위 시각(token timestamps)은 있어도 정확하지 않다.
 *
 * 그래서 **글자 수 비례로 나눈다.** 말이 빨라지거나 쉬는 구간이 있으면 어긋난다.
 * 정확한 값인 척하지 않는다 — 이 시각은 "그 근처에서 재생을 시작하는" 용도이지
 * 증거로 쓸 시각이 아니다. 증거로 쓸 때는 원본 세그먼트의 시각을 봐야 한다.
 *
 * 화자는 그대로 물려받는다. 화자분리는 소리로 하는 것이라 한 세그먼트 안에서
 * 갈리지 않는다 — 갈렸다면 애초에 세그먼트가 나뉘었을 것이다.
 */
export function splitSegmentIntoSentences(
  segment: TranscriptSegment,
  options: SplitSegmentOptions = {},
): TranscriptSegment[] {
  const minChars = options.minChars ?? 4;
  const spans = mergeShortSpans(splitSentences(segment.text), minChars);
  if (spans.length <= 1) return [segment];

  const totalChars = spans.reduce((sum, s) => sum + s.text.trim().length, 0);
  const duration = Math.max(0, segment.endSec - segment.startSec);

  const out: TranscriptSegment[] = [];
  let consumedChars = 0;

  for (const [i, span] of spans.entries()) {
    const chars = span.text.trim().length;
    const from = totalChars > 0 ? consumedChars / totalChars : 0;
    consumedChars += chars;
    const to = totalChars > 0 ? consumedChars / totalChars : 1;

    out.push({
      ...segment,
      id: `${segment.id}.${i}`,
      startSec: segment.startSec + duration * from,
      // 마지막 문장은 원본의 끝 시각을 그대로 쓴다. 반올림으로 끝이 밀리지 않게.
      endSec: i === spans.length - 1 ? segment.endSec : segment.startSec + duration * to,
      text: span.text,
      // rawText 도 같은 자리에서 잘라야 "원문 보기"가 맞는다. 길이가 다르면
      // (이미 교정이 들어간 경우) 자를 수 없으므로 통째로 남긴다.
      rawText:
        segment.rawText === segment.text
          ? span.text
          : segment.rawText,
    });
  }

  return out;
}

/**
 * 너무 짧은 문장을 앞에 붙인다.
 *
 * 첫 문장이 짧으면 붙일 앞이 없으므로 **뒤에** 붙인다.
 * 그냥 버리면 원본 글자를 잃는다 — 그건 절대 안 된다.
 */
function mergeShortSpans(spans: SentenceSpan[], minChars: number): SentenceSpan[] {
  if (spans.length <= 1) return spans;
  const out: SentenceSpan[] = [];

  for (const span of spans) {
    const short = span.text.trim().length < minChars;
    if (short && out.length > 0) {
      const prev = out[out.length - 1];
      out[out.length - 1] = { text: `${prev.text} ${span.text}`, start: prev.start, end: span.end };
    } else {
      out.push({ ...span });
    }
  }

  // 첫 항목이 여전히 짧으면 다음 것과 합친다.
  while (out.length > 1 && out[0].text.trim().length < minChars) {
    const [first, second, ...rest] = out;
    out.splice(0, 2, {
      text: `${first.text} ${second.text}`,
      start: first.start,
      end: second.end,
    });
    if (rest.length === 0) break;
  }

  return out;
}

/** 세그먼트 목록 전체를 문장 단위로 편다. */
export function splitAllIntoSentences(
  segments: readonly TranscriptSegment[],
  options: SplitSegmentOptions = {},
): TranscriptSegment[] {
  return segments.flatMap((s) => splitSegmentIntoSentences(s, options));
}
