import { describe, it, expect } from "vitest";
import { scoreShift, summarizeTrend, taeumTemperature, DISCLAIMER } from "../src/taeum/index.js";
import type { TranscriptSegment, SpeakerRole } from "../src/transcription/types.js";

let seq = 0;
function seg(
  text: string,
  role: SpeakerRole = "senior",
  startSec = seq * 10,
): TranscriptSegment {
  seq++;
  return {
    id: `s${seq}`,
    startSec,
    endSec: startSec + 5,
    rawText: text,
    text,
    speakerRole: role,
  };
}

describe("태움 스코어", () => {
  it("아무 일 없으면 0점", () => {
    const r = scoreShift([
      seg("이 환자 아이오 좀 확인해줄래요?"),
      seg("네 확인하겠습니다", "self"),
    ]);
    expect(r.score).toBe(0);
    expect(r.level).toBe("none");
    expect(r.events).toHaveLength(0);
  });

  it("욕설 한 건이 있으면 점수가 잡힌다", () => {
    const r = scoreShift([seg("야 이 씨발 그것도 못 해?")]);
    expect(r.score).toBeGreaterThan(20);
    expect(r.events[0].category).toBe("insult");
    expect(r.events[0].quote).toContain("씨발");
  });

  it("본인이 한 말은 채점하지 않는다", () => {
    const r = scoreShift([seg("아 씨발 진짜 힘들다", "self")]);
    expect(r.score).toBe(0);
    expect(r.events).toHaveLength(0);
  });

  it("관용구는 욕설로 세지 않는다", () => {
    const r = scoreShift([
      seg("오늘 미친 듯이 바빴어"),
      seg("나이트 연속이라 죽겠다"),
    ]);
    expect(r.events).toHaveLength(0);
  });

  it("역할이 unknown이면 기본적으로 채점하지 않는다", () => {
    const r = scoreShift([seg("이 병신아", "unknown")]);
    expect(r.score).toBe(0);
  });

  it("unknownSpeaker=superior면 unknown도 선배로 본다", () => {
    const r = scoreShift([seg("이 병신아", "unknown")], {
      unknownSpeaker: "superior",
    });
    expect(r.score).toBeGreaterThan(0);
  });

  it("환자·보호자 폭언은 태움 점수와 분리한다", () => {
    const r = scoreShift([seg("야 씨발 간호사 불러", "patient")]);
    expect(r.score).toBe(0);
    expect(r.patientAggression.length).toBeGreaterThan(0);
  });

  it("같은 카테고리가 반복돼도 점수가 폭주하지 않는다", () => {
    const one = scoreShift([seg("이 병신아")]);
    const many = scoreShift([
      seg("이 병신아"),
      seg("병신같이 왜 그래"),
      seg("진짜 병신이네"),
      seg("병신 아니야?"),
      seg("병신"),
    ]);
    expect(many.score).toBeGreaterThan(one.score);
    expect(many.score).toBeLessThan(one.score * 4);
  });

  it("여러 유형이 섞이면 카테고리별로 집계된다", () => {
    const r = scoreShift([
      seg("너 같은 애가 무슨 간호사야"),
      seg("이번 평가에 반영할 거야"),
      seg("커피 좀 사와"),
    ]);
    expect(Object.keys(r.byCategory).sort()).toEqual(
      ["insult", "personal-errand", "threat"].sort(),
    );
    expect(r.level === "caution" || r.level === "severe").toBe(true);
  });

  it("어휘 근거가 없으면 구조 신호만으로 점수를 주지 않는다", () => {
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < 12; i++) segments.push(seg("이건 왜 이렇게 했나요?", "senior", i * 5));
    const r = scoreShift(segments);
    expect(r.signals.questionBursts).toBeGreaterThan(0);
    expect(r.signals.longestSeniorRun).toBeGreaterThanOrEqual(6);
    expect(r.score).toBe(0);
  });

  it("면책 문구를 항상 포함한다", () => {
    expect(scoreShift([]).disclaimer).toBe(DISCLAIMER);
  });
});

describe("추이 요약", () => {
  it("기록이 없으면 빈 요약", () => {
    expect(summarizeTrend([]).average).toBe(0);
  });

  it("심각 근무 횟수와 반복 유형을 짚어준다", () => {
    const r = summarizeTrend([
      { shiftId: "1", date: "2026-08-01", score: 70, level: "severe", topCategory: "insult" },
      { shiftId: "2", date: "2026-08-02", score: 20, level: "watch", topCategory: "insult" },
      { shiftId: "3", date: "2026-08-03", score: 65, level: "severe", topCategory: "threat" },
    ]);
    expect(r.severeCount).toBe(2);
    expect(r.dominantCategory).toBe("insult");
    expect(r.worst?.shiftId).toBe("1");
    expect(r.message).toContain("심각");
  });
});

describe("태움 체온", () => {
  it("레벨 경계가 임상 표현과 맞아떨어진다", () => {
    expect(taeumTemperature(0)).toMatchObject({ celsius: 35.8, label: "저체온", tone: "ok" });
    expect(taeumTemperature(5).label).toBe("정상체온");
    expect(taeumTemperature(10)).toMatchObject({ celsius: 37.0, label: "미열", tone: "muted" });
    expect(taeumTemperature(30)).toMatchObject({ celsius: 37.6, label: "발열", tone: "warn" });
    expect(taeumTemperature(60)).toMatchObject({ celsius: 38.6, label: "고열", tone: "danger" });
    expect(taeumTemperature(100).celsius).toBe(40.0);
  });

  it("범위 밖과 쓰레기 입력은 안전하게 잘린다", () => {
    expect(taeumTemperature(-5).celsius).toBe(35.8);
    expect(taeumTemperature(999).celsius).toBe(40.0);
    expect(taeumTemperature(NaN).celsius).toBe(35.8);
  });
});
