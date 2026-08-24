import { describe, it, expect } from "vitest";
import {
  assignSpeakerRange,
  assignSpeakerFrom,
  fillUnassigned,
  speakerCoverage,
  speakerRuns,
} from "../src/transcription/index.js";
import type { TranscriptSegment } from "../src/transcription/index.js";

function segs(n: number): TranscriptSegment[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    startSec: i * 5,
    endSec: i * 5 + 5,
    rawText: `문장 ${i}`,
    text: `문장 ${i}`,
  }));
}

describe("구간 화자 지정", () => {
  it("두 지점 사이를 양끝 포함해 지정한다", () => {
    const out = assignSpeakerRange(segs(5), "s1", "s3", "senior");
    expect(out.map((s) => s.speakerRole)).toEqual([
      undefined, "senior", "senior", "senior", undefined,
    ]);
  });

  it("거꾸로 눌러도 같은 결과다", () => {
    // 화면에서 아래를 먼저 누르는 일이 실제로 자주 있다.
    const forward = assignSpeakerRange(segs(5), "s1", "s3", "senior");
    const backward = assignSpeakerRange(segs(5), "s3", "s1", "senior");
    expect(backward).toEqual(forward);
  });

  it("원본을 건드리지 않는다", () => {
    const original = segs(3);
    assignSpeakerRange(original, "s0", "s2", "self");
    expect(original.every((s) => s.speakerRole === undefined)).toBe(true);
  });

  it("없는 id면 아무것도 안 바꾼다", () => {
    const out = assignSpeakerRange(segs(3), "s9", "s1", "self");
    expect(out.every((s) => s.speakerRole === undefined)).toBe(true);
  });

  it("여기부터 끝까지 지정한다", () => {
    const out = assignSpeakerFrom(segs(4), "s2", "self");
    expect(out.map((s) => s.speakerRole)).toEqual([
      undefined, undefined, "self", "self",
    ]);
  });

  it("빈 목록에서도 안 터진다", () => {
    expect(assignSpeakerFrom([], "s0", "self")).toEqual([]);
  });

  it("지정 안 된 것만 채운다", () => {
    const partial = assignSpeakerRange(segs(4), "s0", "s1", "self");
    const out = fillUnassigned(partial, "senior");
    expect(out.map((s) => s.speakerRole)).toEqual([
      "self", "self", "senior", "senior",
    ]);
  });
});

describe("지정 진행 상황", () => {
  it("아무것도 안 했으면 지표를 낼 수 없다고 말한다", () => {
    const c = speakerCoverage(segs(3));
    expect(c.labeled).toBe(0);
    expect(c.readyForScoring).toBe(false);
    expect(c.message).toContain("지표를 낼 수 없습니다");
  });

  it("본인이 없으면 막는다", () => {
    // 본인 발화가 없는 채로 점수를 내면 내가 한 말이 남이 한 말로 세어진다.
    // 0점이 나오는 것보다 나쁘다.
    const out = assignSpeakerRange(segs(3), "s0", "s2", "senior");
    const c = speakerCoverage(out);
    expect(c.hasSelf).toBe(false);
    expect(c.readyForScoring).toBe(false);
    expect(c.message).toContain("본인");
  });

  it("본인이 하나라도 있으면 낼 수 있다", () => {
    const out = assignSpeakerRange(segs(3), "s0", "s0", "self");
    const c = speakerCoverage(out);
    expect(c.readyForScoring).toBe(true);
  });

  it("일부만 지정하면 빠지는 것이 있다고 알린다", () => {
    let out = assignSpeakerRange(segs(4), "s0", "s0", "self");
    out = assignSpeakerRange(out, "s1", "s1", "senior");
    const c = speakerCoverage(out);
    expect(c.labeled).toBe(2);
    expect(c.message).toContain("빠집니다");
  });

  it("다 하면 다 했다고 한다", () => {
    let out = fillUnassigned(segs(3), "senior");
    out = assignSpeakerRange(out, "s0", "s0", "self");
    expect(speakerCoverage(out).message).toBe("모두 지정했습니다.");
  });

  it("unknown은 지정한 것으로 세지 않는다", () => {
    const out = segs(2).map((s) => ({ ...s, speakerRole: "unknown" as const }));
    expect(speakerCoverage(out).labeled).toBe(0);
  });
});

describe("연속 구간 묶기", () => {
  it("같은 역할이 이어지면 하나로 묶는다", () => {
    let out = assignSpeakerRange(segs(5), "s0", "s1", "senior");
    out = assignSpeakerRange(out, "s2", "s4", "self");
    const runs = speakerRuns(out);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ role: "senior", startIndex: 0, endIndex: 1, count: 2 });
    expect(runs[1]).toMatchObject({ role: "self", startIndex: 2, endIndex: 4, count: 3 });
  });

  it("구간의 시각이 처음과 끝을 담는다", () => {
    const out = assignSpeakerRange(segs(3), "s0", "s2", "senior");
    const [run] = speakerRuns(out);
    expect(run.startSec).toBe(0);
    expect(run.endSec).toBe(15);
  });

  it("지정 안 된 것도 하나의 구간으로 본다", () => {
    const runs = speakerRuns(segs(3));
    expect(runs.length).toBe(1);
    expect(runs[0].role).toBe("unknown");
  });

  it("빈 목록이면 빈 결과", () => {
    expect(speakerRuns([])).toEqual([]);
  });
});
