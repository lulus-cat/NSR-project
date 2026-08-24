/**
 * 근무 중 괴롭힘 지표 산출.
 *
 * 이 점수의 성격
 * -------------
 * 이건 진단이 아니다. **자기 기록**이다.
 *
 * 신규간호사가 겪는 흔한 상황은 이렇다. 근무가 끝나면 무슨 말을 들었는지 흐릿해지고,
 * "내가 예민한 건가"라는 자기 의심만 남는다. 그 상태로 몇 달이 지나면 기억은 사라지고
 * 소진만 남는다. 이 점수는 그 흐릿함을 붙잡아두기 위한 것이다.
 *
 * 그래서 설계 원칙이 이렇다.
 *   1. 점수보다 **인용문**이 먼저다. 무슨 말이 언제 있었는지가 본체이고 점수는 요약이다.
 *   2. 본인 발화는 채점하지 않는다.
 *   3. 환자·보호자 폭언은 별도로 센다. 대응 경로가 다르기 때문이다.
 *   4. 한 표현이 반복돼도 점수가 무한정 오르지 않는다(체감 가중). 특정 말버릇 하나가
 *      전체 점수를 지배하는 것을 막는다.
 *   5. 어휘 근거가 하나도 없으면 구조 신호(발화 점유율 등)만으로는 점수를 주지 않는다.
 *      말을 많이 하는 것 자체는 괴롭힘이 아니다.
 */

import type { SpeakerRole, TranscriptSegment } from "../transcription/types.js";
import {
  HARASSMENT_PATTERNS,
  PATIENT_AGGRESSION_PATTERNS,
  CATEGORY_LABELS,
  CATEGORY_LEGAL_NOTES,
  type HarassmentCategory,
  type HarassmentPattern,
} from "./patterns.js";

export type { HarassmentCategory };
export { CATEGORY_LABELS, CATEGORY_LEGAL_NOTES };

export interface HarassmentEvent {
  segmentId: string;
  category: HarassmentCategory;
  categoryLabel: string;
  /** 패턴 설명 (예: "인사상 불이익 암시"). */
  label: string;
  severity: number;
  confidence: number;
  /** 실제로 걸린 표현. */
  matched: string;
  /** 근거 인용. 앞뒤 문맥을 포함해 잘라낸다. */
  quote: string;
  atSec: number;
  speakerRole: SpeakerRole;
}

export type TaeumLevel = "none" | "watch" | "caution" | "severe";

export interface TaeumSignals {
  /** 선배·상급자 발화가 전체 발화량에서 차지하는 비율 (0~1). */
  seniorSpeechRatio: number;
  /** 60초 안에 선배의 질문이 3회 이상 몰린 구간의 수. */
  questionBursts: number;
  /** 본인 발화가 끼어들지 못한 채 선배 발화가 이어진 최대 길이. */
  longestSeniorRun: number;
  /** 어휘 근거로 잡힌 이벤트 총수. */
  totalEvents: number;
}

export interface TaeumScore {
  /** 0~100. */
  score: number;
  level: TaeumLevel;
  levelLabel: string;
  events: HarassmentEvent[];
  /** 환자·보호자로부터의 폭언. 태움 점수에는 포함하지 않는다. */
  patientAggression: HarassmentEvent[];
  byCategory: Partial<Record<HarassmentCategory, number>>;
  signals: TaeumSignals;
  /** 화면 상단에 항상 함께 노출해야 하는 문구. */
  disclaimer: string;
}

export const LEVEL_LABELS: Record<TaeumLevel, string> = {
  none: "특이사항 없음",
  watch: "관찰",
  caution: "주의",
  severe: "심각",
};

export const DISCLAIMER =
  "이 점수는 법적 판단이 아니라 본인의 근무 기록입니다. 어조·표정·맥락은 텍스트에 남지 않으므로 " +
  "실제와 다를 수 있습니다. 점수보다 아래 인용문을 직접 확인하세요. " +
  "신고나 상담을 고려한다면 병원 고충처리 부서, 대한간호협회 간호사 인권센터, " +
  "고용노동부 노동포털(직장 내 괴롭힘 신고)을 통해 전문가와 상의하는 것이 좋습니다.";

/** 선배·상급자로 볼 역할. 관계 우위가 인정되기 쉬운 쪽. */
const SUPERIOR_ROLES: ReadonlySet<SpeakerRole> = new Set<SpeakerRole>([
  "senior",
  "doctor",
]);
const PATIENT_ROLES: ReadonlySet<SpeakerRole> = new Set<SpeakerRole>([
  "patient",
  "guardian",
]);

export interface ScoreOptions {
  /**
   * 역할이 지정되지 않은 화자를 어떻게 볼 것인가.
   *  "ignore"  - 채점하지 않는다 (기본값. 안전한 쪽)
   *  "superior"- 선배로 간주한다 (화자분리는 됐지만 라벨을 아직 안 붙였을 때)
   */
  unknownSpeaker?: "ignore" | "superior";
  /** 인용문 최대 길이. */
  quoteLength?: number;
}

/** 매칭 위치 주변을 잘라 인용문을 만든다. */
function makeQuote(text: string, index: number, length: number, max: number): string {
  const pad = Math.max(0, Math.floor((max - length) / 2));
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function scanSegment(
  segment: TranscriptSegment,
  patterns: HarassmentPattern[],
  role: SpeakerRole,
  quoteLength: number,
): HarassmentEvent[] {
  const text = segment.text || segment.rawText;
  const events: HarassmentEvent[] = [];
  for (const pattern of patterns) {
    if (pattern.exclude && pattern.exclude.test(text)) continue;
    const re = new RegExp(pattern.match.source, pattern.match.flags.includes("g") ? pattern.match.flags : `${pattern.match.flags}g`);
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      events.push({
        segmentId: segment.id,
        category: pattern.category,
        categoryLabel: CATEGORY_LABELS[pattern.category],
        label: pattern.label,
        severity: pattern.severity,
        confidence: pattern.confidence,
        matched: m[0],
        quote: makeQuote(text, index, m[0].length, quoteLength),
        atSec: segment.startSec,
        speakerRole: role,
      });
      // 같은 세그먼트에서 같은 패턴이 여러 번 걸려도 한 번만 센다.
      // 한 문장 안의 반복은 별개 사건이 아니다.
      break;
    }
  }
  return events;
}

const QUESTION_ENDING = /[?？]|(?:니|냐|나요|까요|가요|는가|는데요|죠|지요)\s*[.!]?\s*$/;

function isQuestion(text: string): boolean {
  const sentences = text.split(/(?<=[.!?？。])\s*/).filter((s) => s.trim());
  return sentences.some((s) => QUESTION_ENDING.test(s.trim()));
}

function resolveRole(
  segment: TranscriptSegment,
  unknownSpeaker: "ignore" | "superior",
): SpeakerRole {
  const role = segment.speakerRole ?? "unknown";
  if (role === "unknown" && unknownSpeaker === "superior") return "senior";
  return role;
}

function computeSignals(
  segments: TranscriptSegment[],
  unknownSpeaker: "ignore" | "superior",
  totalEvents: number,
): TaeumSignals {
  let superiorChars = 0;
  let allChars = 0;
  let run = 0;
  let longestRun = 0;
  const superiorQuestionTimes: number[] = [];

  for (const seg of segments) {
    const text = seg.text || seg.rawText;
    const role = resolveRole(seg, unknownSpeaker);
    allChars += text.length;
    if (SUPERIOR_ROLES.has(role)) {
      superiorChars += text.length;
      run += 1;
      if (run > longestRun) longestRun = run;
      if (isQuestion(text)) superiorQuestionTimes.push(seg.startSec);
    } else if (role === "self") {
      run = 0;
    }
  }

  // 60초 창 안에 질문 3개 이상이 몰린 구간을 센다. 창이 겹치지 않도록 건너뛴다.
  let bursts = 0;
  for (let i = 0; i < superiorQuestionTimes.length; ) {
    let j = i;
    while (
      j < superiorQuestionTimes.length &&
      superiorQuestionTimes[j] - superiorQuestionTimes[i] <= 60
    ) {
      j++;
    }
    if (j - i >= 3) {
      bursts += 1;
      i = j;
    } else {
      i += 1;
    }
  }

  return {
    seniorSpeechRatio: allChars > 0 ? superiorChars / allChars : 0,
    questionBursts: bursts,
    longestSeniorRun: longestRun,
    totalEvents,
  };
}

/**
 * 카테고리별로 체감 가중을 적용해 원점수를 만든다.
 * 같은 카테고리의 n번째 사건은 0.7^(n-1)만큼만 반영된다.
 * 말버릇 하나가 점수를 지배하는 것을 막기 위한 장치다.
 */
function rawScore(events: HarassmentEvent[]): {
  raw: number;
  byCategory: Partial<Record<HarassmentCategory, number>>;
} {
  const grouped = new Map<HarassmentCategory, number[]>();
  for (const e of events) {
    const list = grouped.get(e.category) ?? [];
    list.push(e.severity * e.confidence);
    grouped.set(e.category, list);
  }
  let raw = 0;
  const byCategory: Partial<Record<HarassmentCategory, number>> = {};
  for (const [category, values] of grouped) {
    values.sort((a, b) => b - a);
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i] * Math.pow(0.7, i);
    byCategory[category] = Math.round(sum * 10) / 10;
    raw += sum;
  }
  return { raw, byCategory };
}

function levelOf(score: number): TaeumLevel {
  if (score >= 60) return "severe";
  if (score >= 30) return "caution";
  if (score >= 10) return "watch";
  return "none";
}

/**
 * 근무 한 건의 전사본을 채점한다.
 */
export function scoreShift(
  segments: TranscriptSegment[],
  options: ScoreOptions = {},
): TaeumScore {
  const unknownSpeaker = options.unknownSpeaker ?? "ignore";
  const quoteLength = options.quoteLength ?? 80;

  const events: HarassmentEvent[] = [];
  const patientAggression: HarassmentEvent[] = [];

  for (const segment of segments) {
    const role = resolveRole(segment, unknownSpeaker);
    // 본인이 한 말은 태움이 아니다.
    if (role === "self") continue;

    if (PATIENT_ROLES.has(role)) {
      patientAggression.push(
        ...scanSegment(segment, PATIENT_AGGRESSION_PATTERNS, role, quoteLength),
      );
      continue;
    }
    if (role === "unknown") continue;
    events.push(...scanSegment(segment, HARASSMENT_PATTERNS, role, quoteLength));
  }

  const { raw, byCategory } = rawScore(events);
  const signals = computeSignals(segments, unknownSpeaker, events.length);

  // 구조 신호는 어휘 근거가 있을 때만 가산한다.
  // 선배가 말을 많이 하는 것 자체는 괴롭힘이 아니다.
  let adjusted = raw;
  if (events.length > 0) {
    adjusted += signals.questionBursts * 1.5;
    if (signals.longestSeniorRun >= 6) adjusted += 2;
    if (signals.seniorSpeechRatio >= 0.8) adjusted += 2;
  }

  // 포화 함수: 한 건의 중대 사건도 점수를 만들되, 누적은 100에 수렴한다.
  const score = Math.round(100 * (1 - Math.exp(-adjusted / 12)));
  const level = levelOf(score);

  return {
    score,
    level,
    levelLabel: LEVEL_LABELS[level],
    events: events.sort((a, b) => b.severity * b.confidence - a.severity * a.confidence),
    patientAggression,
    byCategory,
    signals,
    disclaimer: DISCLAIMER,
  };
}

/** 여러 근무의 추이. 하루 점수보다 **패턴**이 중요하다. */
export interface TaeumTrendPoint {
  shiftId: string;
  date: string;
  score: number;
  level: TaeumLevel;
  topCategory?: HarassmentCategory;
}

export function summarizeTrend(points: TaeumTrendPoint[]): {
  average: number;
  worst: TaeumTrendPoint | null;
  severeCount: number;
  /** 가장 자주 나타난 유형. 반복성은 괴롭힘 판단의 핵심 요소다. */
  dominantCategory: HarassmentCategory | null;
  message: string;
} {
  if (points.length === 0) {
    return {
      average: 0,
      worst: null,
      severeCount: 0,
      dominantCategory: null,
      message: "기록된 근무가 없습니다.",
    };
  }
  const average =
    Math.round((points.reduce((s, p) => s + p.score, 0) / points.length) * 10) / 10;
  const worst = points.reduce((a, b) => (b.score > a.score ? b : a));
  const severeCount = points.filter((p) => p.level === "severe").length;

  const counts = new Map<HarassmentCategory, number>();
  for (const p of points) {
    if (!p.topCategory) continue;
    counts.set(p.topCategory, (counts.get(p.topCategory) ?? 0) + 1);
  }
  let dominantCategory: HarassmentCategory | null = null;
  let max = 0;
  for (const [c, n] of counts) {
    if (n > max) {
      max = n;
      dominantCategory = c;
    }
  }

  const parts = [`최근 ${points.length}개 근무 평균 ${average}점.`];
  if (severeCount > 0) {
    parts.push(
      `'심각' 수준이 ${severeCount}회 있었습니다. 반복성은 직장 내 괴롭힘 판단에서 중요한 요소이므로, ` +
        `해당 근무의 인용문을 따로 보관해두는 것을 권합니다.`,
    );
  } else if (average >= 30) {
    parts.push("특정 유형이 반복되고 있는지 인용문을 확인해보세요.");
  } else {
    parts.push("두드러진 반복 패턴은 확인되지 않았습니다.");
  }
  if (dominantCategory) {
    parts.push(`가장 자주 나타난 유형: ${CATEGORY_LABELS[dominantCategory]}.`);
  }

  return { average, worst, severeCount, dominantCategory, message: parts.join(" ") };
}
