import { describe, it, expect } from "vitest";
import {
  generateCards,
  countByKind,
  newCardState,
  review,
  dueStates,
  studyStats,
  shiftDueDateOffDuty,
  DAY_MS,
  buildShiftReport,
  reportToMarkdown,
} from "../src/study/index.js";
import { correctTranscript } from "../src/transcription/index.js";
import type { CardSourceSegment } from "../src/study/cards.js";
import type { SpeakerRole } from "../src/transcription/types.js";

const NOW = 1_756_000_000_000;

function makeSegment(
  id: string,
  raw: string,
  speakerRole: SpeakerRole = "senior",
  startSec = 0,
): CardSourceSegment {
  const r = correctTranscript(raw);
  return { segmentId: id, text: r.text, annotations: r.annotations, speakerRole, startSec };
}

describe("학습카드 생성", () => {
  it("전사본에서 용어 카드를 만든다", () => {
    const cards = generateCards({
      shiftId: "shift-1",
      segments: [makeSegment("s1", "이 환자 엔피오 유지하고 아이오 정확히 재주세요")],
      now: NOW,
    });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((c) => c.entryId === "npo")).toBe(true);
  });

  it("실제 들은 문장으로 빈칸 카드를 만든다", () => {
    const cards = generateCards({
      segments: [makeSegment("s1", "이 환자 엔피오 유지하고 아이오 정확히 재주세요")],
      now: NOW,
    });
    const cloze = cards.find((c) => c.kind === "cloze");
    expect(cloze).toBeDefined();
    expect(cloze!.front).toContain("____");
    expect(cloze!.front).not.toContain(cloze!.back.split("\n")[0]);
  });

  it("은어에는 공식 표현 카드가 붙는다", () => {
    const cards = generateCards({
      segments: [makeSegment("s1", "일단 옵세하고 있어요")],
      now: NOW,
    });
    const formal = cards.find((c) => c.kind === "formal");
    expect(formal).toBeDefined();
    expect(formal!.back).toContain("경과 관찰");
  });

  it("이미 아는 용어는 카드를 만들지 않는다", () => {
    const cards = generateCards({
      segments: [makeSegment("s1", "석션 먼저 하고 드레싱 하세요")],
      knownEntryIds: new Set(["suction", "dressing"]),
      now: NOW,
    });
    expect(cards).toHaveLength(0);
  });

  it("한 용어당 빈칸 카드 수를 제한한다", () => {
    const segments = Array.from({ length: 5 }, (_, i) =>
      makeSegment(`s${i}`, "석션 먼저 하고 나서 기록 남겨주세요", "senior", i * 10),
    );
    const cards = generateCards({ segments, now: NOW, maxClozePerTerm: 2 });
    expect(cards.filter((c) => c.kind === "cloze" && c.entryId === "suction")).toHaveLength(2);
  });

  it("카드 종류를 집계한다", () => {
    const cards = generateCards({
      segments: [makeSegment("s1", "엔피오 유지하고 폴리 확인해주세요")],
      now: NOW,
    });
    const counts = countByKind(cards);
    expect(counts.definition).toBeGreaterThan(0);
  });
});

describe("간격 반복 (SM-2)", () => {
  it("새 카드는 즉시 복습 대상", () => {
    const s = newCardState("c1", NOW);
    expect(s.dueAt).toBe(NOW);
    expect(s.repetitions).toBe(0);
  });

  it("성공하면 간격이 1일 → 6일 → 그 이상으로 늘어난다", () => {
    let s = newCardState("c1", NOW);
    s = review(s, 4, NOW);
    expect(s.intervalDays).toBe(1);
    s = review(s, 4, NOW + DAY_MS);
    expect(s.intervalDays).toBe(6);
    s = review(s, 4, NOW + 7 * DAY_MS);
    expect(s.intervalDays).toBeGreaterThan(6);
  });

  it("실패하면 처음으로 돌아가고 lapse가 오른다", () => {
    let s = newCardState("c1", NOW);
    s = review(s, 5, NOW);
    s = review(s, 5, NOW + DAY_MS);
    s = review(s, 1, NOW + 7 * DAY_MS);
    expect(s.repetitions).toBe(0);
    expect(s.intervalDays).toBe(1);
    expect(s.lapses).toBe(1);
  });

  it("용이도는 1.3 아래로 내려가지 않는다", () => {
    let s = newCardState("c1", NOW);
    for (let i = 0; i < 20; i++) s = review(s, 0, NOW + i * DAY_MS);
    expect(s.easeFactor).toBeGreaterThanOrEqual(1.3);
  });

  it("밀린 카드를 오래된 순으로 낸다", () => {
    const states = [
      { ...newCardState("a", NOW), dueAt: NOW - 100 },
      { ...newCardState("b", NOW), dueAt: NOW - 5000 },
      { ...newCardState("c", NOW), dueAt: NOW + 5000 },
    ];
    const due = dueStates(states, NOW);
    expect(due.map((s) => s.cardId)).toEqual(["b", "a"]);
  });

  it("학습 통계를 낸다", () => {
    const states = [
      { ...newCardState("a", NOW), intervalDays: 30, repetitions: 5 },
      { ...newCardState("b", NOW), lapses: 5 },
    ];
    const stats = studyStats(states, NOW);
    expect(stats.mature).toBe(1);
    expect(stats.leeches).toBe(1);
    expect(stats.due).toBe(2);
  });

  it("나이트 근무일에 걸린 복습은 공부 가능한 날로 옮긴다", () => {
    const start = new Date(2026, 7, 24, 9, 0, 0).getTime();
    const nightDay = new Date(2026, 7, 24, 0, 0, 0).getTime();
    const canStudy = (dayStart: number) => dayStart !== nightDay;
    const moved = shiftDueDateOffDuty(start, canStudy);
    expect(moved).toBeGreaterThan(start);
    expect(new Date(moved).getDate()).toBe(25);
  });

  it("옮길 수 있는 날이 없으면 원래 날짜를 유지한다", () => {
    const start = new Date(2026, 7, 24, 9, 0, 0).getTime();
    expect(shiftDueDateOffDuty(start, () => false)).toBe(start);
  });
});

describe("근무 보고서", () => {
  const segments: CardSourceSegment[] = [
    makeSegment("s1", "엔피오 유지하고 아이오 정확히 재야 돼요", "senior", 30),
    makeSegment("s2", "네 알겠습니다", "self", 40),
    makeSegment("s3", "그건 나중에 알려줄게요", "senior", 120),
    makeSegment("s4", "아까 그 기록 깜빡했어요", "self", 300),
    makeSegment("s5", "일단 옵세하고 있어요", "senior", 400),
  ];

  const report = buildShiftReport({
    shiftId: "shift-1",
    date: "2026-08-24",
    dutyLabel: "데이 (D)",
    recordedSec: 8 * 3600,
    segments,
    termIds: ["npo", "intake-output", "observation"],
  });

  it("지시 발화를 뽑는다", () => {
    expect(report.instructions.some((q) => q.segmentId === "s1")).toBe(true);
  });

  it("본인 혼잣말은 지시로 세지 않는다", () => {
    expect(report.instructions.every((q) => q.speakerRole !== "self")).toBe(true);
  });

  it("미뤄진 항목을 확인 목록으로 뽑는다", () => {
    expect(report.unresolved.some((q) => q.segmentId === "s3")).toBe(true);
  });

  it("실수 언급을 뽑는다", () => {
    expect(report.mistakes.some((q) => q.segmentId === "s4")).toBe(true);
  });

  it("은어를 공식 표현으로 바꿔주는 표를 만든다", () => {
    expect(report.glossaryFixes.some((g) => g.formal === "경과 관찰")).toBe(true);
  });

  it("마크다운으로 내보낸다", () => {
    const md = reportToMarkdown(report);
    expect(md).toContain("# 2026-08-24 근무 기록");
    expect(md).toContain("## 신규 용어");
    expect(md).toContain("## 미확인·확인 필요 사항");
  });
});

describe("오늘의 한 줄", () => {
  it("같은 날엔 같은 문장, 날이 바뀌면 대체로 다른 문장", async () => {
    const { dailyQuote } = await import("../src/study/quotes.js");
    expect(dailyQuote("2026-08-25")).toEqual(dailyQuote("2026-08-25"));
    const texts = new Set(
      Array.from({ length: 30 }, (_, i) => dailyQuote(`2026-09-${String(i + 1).padStart(2, "0")}`).text),
    );
    expect(texts.size).toBeGreaterThan(10);
  });
});
