import { describe, expect, it } from "vitest";
import { tiroParagraphsToSegments, type TiroParagraph } from "../src/index.js";

const BASE = Date.parse("2026-09-04T09:00:00Z");
const at = (min: number, sec = 0) =>
  new Date(BASE + min * 60_000 + sec * 1000).toISOString();

describe("tiroParagraphsToSegments", () => {
  it("문단 시각을 녹음 시작 기준 초로 바꾼다", () => {
    const paragraphs: TiroParagraph[] = [
      { timeFrom: at(0, 10), timeTo: at(0, 15), transcript: { content: "인계 시작할게요." } },
      { timeFrom: at(1, 0), timeTo: at(1, 8), transcript: { content: "이 환자분은 금식이에요." } },
    ];
    const { segments, locked } = tiroParagraphsToSegments(paragraphs, BASE);
    expect(locked).toBe(0);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startSec: 10, endSec: 15, text: "인계 시작할게요." });
    expect(segments[1].startSec).toBe(60);
    expect(segments[1].endSec).toBe(68);
  });

  it("잠긴 문단은 버리고 개수를 센다", () => {
    const paragraphs: TiroParagraph[] = [
      { timeFrom: at(0), timeTo: at(1), transcript: { content: "여기까지는 보여요." } },
      { timeFrom: at(1), timeTo: at(2), locked: true, transcript: { content: "▒▒▒ ▒▒▒▒" } },
      { timeFrom: at(2), timeTo: at(3), locked: true, transcript: { content: "▒▒ ▒▒" } },
    ];
    const { segments, locked } = tiroParagraphsToSegments(paragraphs, BASE);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("여기까지는 보여요.");
    expect(locked).toBe(2);
  });

  it("화자 조각이 있으면 글자 수 비율로 구간을 나눈다", () => {
    // 문단은 0~10초. 글자 수가 3:1 이면 구간도 3:1 로 갈린다.
    const paragraphs: TiroParagraph[] = [
      {
        timeFrom: at(0, 0),
        timeTo: at(0, 10),
        diarizedSegments: [
          { content: "123456", speaker: { label: "SPEAKER_0" } },
          { content: "78", speaker: { label: "SPEAKER_1" } },
        ],
      },
    ];
    const { segments } = tiroParagraphsToSegments(paragraphs, BASE);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startSec: 0, endSec: 7.5, speakerId: "SPEAKER_0" });
    expect(segments[1]).toMatchObject({ startSec: 7.5, endSec: 10, speakerId: "SPEAKER_1" });
  });

  it("화자에 붙은 사람 이름은 가져오지 않는다", () => {
    // 티로에서 화자에 실명을 붙여 뒀을 수 있다. 병동 사람의 실명이 전사본
    // 화자 칸에 그대로 들어가면 안 된다 — 기계 이름표만 쓴다.
    const paragraphs: TiroParagraph[] = [
      {
        timeFrom: at(0),
        timeTo: at(1),
        diarizedSegments: [
          {
            content: "혈압 먼저 재 주세요.",
            speaker: { label: "SPEAKER_0", personName: "김선영" },
          },
        ],
      },
    ];
    const { segments } = tiroParagraphsToSegments(paragraphs, BASE);
    expect(segments[0].speakerId).toBe("SPEAKER_0");
    expect(JSON.stringify(segments)).not.toContain("김선영");
  });

  it("시각이 없는 문단은 앞 문단 끝에 붙인다", () => {
    const paragraphs: TiroParagraph[] = [
      { timeFrom: at(0, 0), timeTo: at(0, 30), transcript: { content: "첫 문단이에요." } },
      { transcript: { content: "시각이 없는 문단이에요." } },
    ];
    const { segments } = tiroParagraphsToSegments(paragraphs, BASE);
    expect(segments[1].startSec).toBe(30);
    expect(segments[1].endSec).toBe(30);
  });

  it("빈 문단과 공백만 있는 조각은 버린다", () => {
    const paragraphs: TiroParagraph[] = [
      { timeFrom: at(0), timeTo: at(1), transcript: { content: "   " } },
      { timeFrom: at(1), timeTo: at(2), transcript: null },
      { timeFrom: at(2), timeTo: at(3), diarizedSegments: [{ content: "  ", speaker: { label: "SPEAKER_0" } }] },
      { timeFrom: at(3), timeTo: at(4), transcript: { content: "이건 남아요." } },
    ];
    const { segments } = tiroParagraphsToSegments(paragraphs, BASE);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("이건 남아요.");
  });

  it("기준점보다 이른 시각은 0 아래로 내려가지 않는다", () => {
    const paragraphs: TiroParagraph[] = [
      { timeFrom: at(-1), timeTo: at(0, 5), transcript: { content: "조금 일찍 시작했어요." } },
    ];
    const { segments } = tiroParagraphsToSegments(paragraphs, BASE);
    expect(segments[0].startSec).toBe(0);
    expect(segments[0].endSec).toBe(5);
  });
});
