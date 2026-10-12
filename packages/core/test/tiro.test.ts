import { describe, expect, it } from "vitest";
import {
  matchTiroUploads,
  tiroParagraphsToSegments,
  type TiroParagraph,
  type UploadNote,
} from "../src/index.js";

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

describe("matchTiroUploads — 티로로 보낸 녹음의 노트를 찾는다", () => {
  const H = 3600;
  const ENDED = Date.parse("2026-10-12T17:30:00+09:00");
  const rec = (id: string, shiftId: string, durationSec: number, endedAt = ENDED) => ({
    id,
    shiftId,
    durationSec,
    endedAt,
    fileStem: `${shiftId.replace(/:/g, "_")}__${id}`,
  });
  const note = (guid: string, durationSec: number, extra: Partial<UploadNote> = {}): UploadNote => ({
    guid,
    title: "근무 녹음",
    source: "recording",
    createdAt: ENDED + 20 * 60_000,
    durationSec,
    ...extra,
  });

  it("파일을 올려 만든 노트를, 그 녹음이 끝난 뒤에 생겼고 길이가 같으면 짝짓는다", () => {
    const pairs = matchTiroUploads([note("n1", 3 * H + 2)], [rec("000", "2026-10-12:D", 3 * H)]);
    expect(pairs).toEqual([{ noteGuid: "n1", recordingId: "000", shiftId: "2026-10-12:D" }]);
  });

  it("티로 앱으로 직접 녹음한 노트는 이 앱의 녹음이 아니다 — 안 붙인다", () => {
    const live = note("n1", 3 * H, { source: "live-voice" });
    expect(matchTiroUploads([live], [rec("000", "2026-10-12:D", 3 * H)])).toEqual([]);
  });

  it("녹음이 끝나기 전에 생긴 노트는 그 녹음일 수 없다", () => {
    const early = note("n1", 3 * H, { createdAt: ENDED - 30 * 60_000 });
    expect(matchTiroUploads([early], [rec("000", "2026-10-12:D", 3 * H)])).toEqual([]);
  });

  it("길이가 다르면 안 붙인다", () => {
    expect(matchTiroUploads([note("n1", 2 * H)], [rec("000", "2026-10-12:D", 3 * H)])).toEqual([]);
  });

  it("두 근무에 걸리면 틀리게 붙이느니 안 붙인다 — 손으로 고르게 둔다", () => {
    const recs = [rec("000", "2026-10-11:N", 3 * H), rec("000b", "2026-10-12:D", 3 * H)];
    expect(matchTiroUploads([note("n1", 3 * H)], recs)).toEqual([]);
  });

  it("한 근무의 같은 길이 조각 둘은 노트 둘에 하나씩 붙는다 — 같은 녹음에 두 번 안 붙는다", () => {
    const recs = [rec("000", "2026-10-12:D", 3 * H), rec("001", "2026-10-12:D", 3 * H)];
    const pairs = matchTiroUploads([note("n1", 3 * H), note("n2", 3 * H)], recs);
    expect(pairs.map((p) => p.shiftId)).toEqual(["2026-10-12:D", "2026-10-12:D"]);
    expect(new Set(pairs.map((p) => p.recordingId))).toEqual(new Set(["000", "001"]));
  });

  it("같은 파일을 두 번 올렸으면 먼저 생긴 노트만 붙는다", () => {
    const pairs = matchTiroUploads(
      [note("later", 3 * H, { createdAt: ENDED + 50 * 60_000 }), note("first", 3 * H)],
      [rec("000", "2026-10-12:D", 3 * H)],
    );
    expect(pairs).toEqual([{ noteGuid: "first", recordingId: "000", shiftId: "2026-10-12:D" }]);
  });

  it("'보냈다' 표시가 안 된 녹음은 제목(파일 이름)으로만 붙는다", () => {
    const unsent = { ...rec("000", "2026-10-12:D", 3 * H), titleOnly: true };
    // 길이만 같은 노트는 안 붙는다 — 보냈는지도 모르는 녹음에 길이로 짝지으면 위험하다.
    expect(matchTiroUploads([note("n1", 3 * H)], [unsent])).toEqual([]);
    // 제목에 그 파일 이름이 있으면 티로에 간 것이 확실하다.
    const named = note("n2", 3 * H, { title: "2026-10-12_D__000" });
    expect(matchTiroUploads([named], [unsent])).toEqual([
      { noteGuid: "n2", recordingId: "000", shiftId: "2026-10-12:D" },
    ]);
  });

  it("제목에 파일 이름이 남아 있으면 길이가 달라도 그 녹음이다", () => {
    const named = note("n1", 0, { title: "2026-10-12_D__000.m4a" });
    const pairs = matchTiroUploads([named], [rec("000", "2026-10-12:D", 3 * H)]);
    expect(pairs).toEqual([{ noteGuid: "n1", recordingId: "000", shiftId: "2026-10-12:D" }]);
  });
});
