/**
 * 근무 보고서 생성.
 *
 * 목적이 두 가지다.
 *  1. **복기** - 8시간 동안 들은 것 중 남길 것을 추린다. 근무 직후 30분이 지나면
 *     대부분 사라진다. 그 전에 붙잡아두기 위한 틀.
 *  2. **다음 근무 준비** - 오늘 못 알아들은 것과 확인 못 한 것이 내일의 할 일이 된다.
 *
 * 여기서는 **규칙 기반**으로 뽑는다. 모델 없이도 되는 만큼은 기기 안에서 끝낸다.
 * 규칙으로 못 잡는 요약·재구성은 앱 레이어에서 선택적으로 LLM에 맡긴다
 * (그 경우 비식별화가 먼저 적용된다 - transcription/engine.ts 참고).
 */

import type { Lexicon } from "../lexicon/index.js";
import { defaultLexicon } from "../lexicon/index.js";
import type { SpeakerRole } from "../transcription/types.js";
import type { TaeumScore } from "../taeum/score.js";
import type { CardSourceSegment } from "./cards.js";

export interface ShiftReportInput {
  shiftId: string;
  /** "2026-08-24" */
  date: string;
  /** "데이 (D)" 같은 표시용 라벨. */
  dutyLabel: string;
  /** 실제 기록된 길이(초). */
  recordedSec: number;
  segments: CardSourceSegment[];
  /** 이 근무에서 등장한 용어 id (correctTranscript 결과를 합친 것). */
  termIds: string[];
  /** 이미 아는 용어. 신규 용어 목록에서 뺀다. */
  knownEntryIds?: ReadonlySet<string>;
  taeum?: TaeumScore;
  lexicon?: Lexicon;
}

export interface ReportQuote {
  segmentId: string;
  atSec: number;
  text: string;
  speakerRole: SpeakerRole;
}

export interface TermSummary {
  entryId: string;
  ko: string;
  definition: string;
  abbr?: string;
  informal?: boolean;
  formal?: string;
  sourceIds: string[];
}

export interface ShiftReport {
  shiftId: string;
  date: string;
  dutyLabel: string;
  recordedSec: number;
  /** 오늘 처음 나온 용어. 내일 다시 나올 것들이다. */
  newTerms: TermSummary[];
  /** 이미 아는 용어 중 오늘도 나온 것. 복습 우선순위 산정에 쓴다. */
  reviewedTerms: TermSummary[];
  /** 지시·교육으로 보이는 발화. */
  instructions: ReportQuote[];
  /** 답을 못 받았거나 뒤로 미뤄진 것. 다음 근무 전 확인 대상. */
  unresolved: ReportQuote[];
  /** 실수·누락이 언급된 지점. */
  mistakes: ReportQuote[];
  /** 기록에 쓸 때 바꿔야 할 은어 목록. */
  glossaryFixes: { informal: string; formal: string }[];
  taeum?: TaeumScore;
}

/**
 * 지시·교육 발화의 표지.
 *
 * 핵심은 `[가-힣]야\s?(돼|된다…)` 형태다. 한국어의 의무 표현은
 * "해야 돼"만이 아니라 "재야 돼", "달아야 돼", "확인해야 됩니다"처럼
 * **동사 어간이 앞에 붙어서** 나타난다. 그래서 "해야"만 찾으면 절반을 놓친다.
 */
const INSTRUCTION_MARKERS =
  /([가-힣]야\s?(돼|된다|되고|되는|해|합니다|됩니다)|하면\s?안\s?(돼|된다|되)|할\s?때는|반드시|꼭\s|기억해|외워|다음(엔|부터)|이렇게\s?(해|하는)|잊지\s?마)/;

/** 뒤로 미뤄진 것의 표지. */
const DEFERRED_MARKERS =
  /(나중에|이따가|다음에\s?알려|찾아\s?봐|물어\s?봐|확인해\s?봐|모르겠|잘\s?모르|알아\s?봐)/;

/** 실수·누락 언급의 표지. */
const MISTAKE_MARKERS =
  /(빠뜨|누락|잘못\s?(했|나|됐)|틀렸|실수|안\s?했|못\s?했|깜빡|놓쳤|빼먹)/;

function toQuote(segment: CardSourceSegment): ReportQuote {
  return {
    segmentId: segment.segmentId,
    atSec: segment.startSec,
    text: segment.text.trim(),
    speakerRole: segment.speakerRole ?? "unknown",
  };
}

function summarize(
  lexicon: Lexicon,
  entryId: string,
): TermSummary | null {
  const e = lexicon.get(entryId);
  if (!e) return null;
  return {
    entryId: e.id,
    ko: e.ko,
    definition: e.definition,
    abbr: e.abbr,
    informal: e.informal,
    formal: e.formal,
    sourceIds: e.sources ?? [],
  };
}

export function buildShiftReport(input: ShiftReportInput): ShiftReport {
  const lexicon = input.lexicon ?? defaultLexicon;
  const known = input.knownEntryIds ?? new Set<string>();

  const newTerms: TermSummary[] = [];
  const reviewedTerms: TermSummary[] = [];
  for (const id of input.termIds) {
    const summary = summarize(lexicon, id);
    if (!summary) continue;
    (known.has(id) ? reviewedTerms : newTerms).push(summary);
  }

  const instructions: ReportQuote[] = [];
  const unresolved: ReportQuote[] = [];
  const mistakes: ReportQuote[] = [];

  for (const segment of input.segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const role = segment.speakerRole ?? "unknown";

    // 지시는 상급자 발화에서만 뽑는다. 본인이 혼잣말로 "해야 돼"라고 한 건 지시가 아니다.
    if (role !== "self" && role !== "patient" && role !== "guardian") {
      if (INSTRUCTION_MARKERS.test(text)) instructions.push(toQuote(segment));
    }
    if (DEFERRED_MARKERS.test(text)) unresolved.push(toQuote(segment));
    if (MISTAKE_MARKERS.test(text)) mistakes.push(toQuote(segment));
  }

  const glossaryFixes = newTerms
    .concat(reviewedTerms)
    .filter((t) => t.informal && t.formal)
    .map((t) => ({ informal: t.ko, formal: t.formal as string }));

  return {
    shiftId: input.shiftId,
    date: input.date,
    dutyLabel: input.dutyLabel,
    recordedSec: input.recordedSec,
    newTerms,
    reviewedTerms,
    instructions,
    unresolved,
    mistakes,
    glossaryFixes,
    taeum: input.taeum,
  };
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}분`;
  return `${h}시간 ${m}분`;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ROLE_LABELS: Record<SpeakerRole, string> = {
  self: "본인",
  senior: "선배",
  doctor: "의사",
  patient: "환자",
  guardian: "보호자",
  other: "기타",
  unknown: "미확인",
};

/** 보고서를 마크다운으로. 앱에서 공유·내보내기 할 때 쓴다. */
export function reportToMarkdown(report: ShiftReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.date} 근무 기록 — ${report.dutyLabel}`);
  lines.push("");
  lines.push(`- 기록 길이: ${formatDuration(report.recordedSec)}`);
  lines.push(`- 감지된 용어: ${report.newTerms.length + report.reviewedTerms.length}개 (신규 ${report.newTerms.length}개)`);
  lines.push("");

  if (report.newTerms.length > 0) {
    lines.push("## 신규 용어");
    lines.push("");
    for (const t of report.newTerms) {
      const label = t.abbr ? `**${t.ko}** (${t.abbr})` : `**${t.ko}**`;
      lines.push(`- ${label} — ${t.definition}`);
    }
    lines.push("");
  }

  if (report.instructions.length > 0) {
    lines.push("## 지시·교육받은 내용");
    lines.push("");
    for (const q of report.instructions) {
      lines.push(`- \`${formatTime(q.atSec)}\` (${ROLE_LABELS[q.speakerRole]}) ${q.text}`);
    }
    lines.push("");
  }

  if (report.unresolved.length > 0) {
    lines.push("## 미확인·확인 필요 사항");
    lines.push("");
    lines.push("다음 근무 전 확인 및 숙지가 필요한 사항입니다.");
    lines.push("");
    for (const q of report.unresolved) {
      lines.push(`- [ ] \`${formatTime(q.atSec)}\` ${q.text}`);
    }
    lines.push("");
  }

  if (report.mistakes.length > 0) {
    lines.push("## 누락 및 특이사항 언급");
    lines.push("");
    lines.push(
      "업무 절차 개선 및 반복적 누락 방지를 위한 기록입니다.",
    );
    lines.push("");
    for (const q of report.mistakes) {
      lines.push(`- \`${formatTime(q.atSec)}\` ${q.text}`);
    }
    lines.push("");
  }

  if (report.glossaryFixes.length > 0) {
    lines.push("## 간호기록 용어 전환");
    lines.push("");
    lines.push("| 구어체 표현 | 간호기록 용어 |");
    lines.push("| --- | --- |");
    for (const g of report.glossaryFixes) {
      lines.push(`| ${g.informal} | ${g.formal} |`);
    }
    lines.push("");
  }

  if (report.taeum) {
    const t = report.taeum;
    lines.push("## 근무 환경 기록");
    lines.push("");
    lines.push(`- 지표: **${t.score}점 (${t.levelLabel})**`);
    if (t.events.length > 0) {
      lines.push("");
      for (const e of t.events.slice(0, 10)) {
        lines.push(`  - \`${formatTime(e.atSec)}\` [${e.categoryLabel}] "${e.quote}"`);
      }
    }
    if (t.patientAggression.length > 0) {
      lines.push("");
      lines.push(
        `- 응대 중 폭언 ${t.patientAggression.length}건 별도 기록됨 (원내 보안 절차 적용 대상).`,
      );
    }
    lines.push("");
    lines.push(`> ${t.disclaimer}`);
    lines.push("");
  }

  return lines.join("\n");
}
