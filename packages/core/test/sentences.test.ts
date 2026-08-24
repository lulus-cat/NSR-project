import { describe, it, expect } from "vitest";
import {
  splitSentences,
  splitSegmentIntoSentences,
  splitAllIntoSentences,
} from "../src/transcription/index.js";
import type { TranscriptSegment } from "../src/transcription/index.js";

function seg(over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "r1#s0",
    startSec: 0,
    endSec: 10,
    rawText: over.text ?? "",
    text: "",
    ...over,
  };
}

describe("문장 나누기", () => {
  it("빈 글은 빈 목록", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });

  it("문장부호로 나눈다", () => {
    const spans = splitSentences("열이 났어요. 노티했습니다.");
    expect(spans.map((s) => s.text)).toEqual(["열이 났어요.", "노티했습니다."]);
  });

  it("부호가 없어도 종결어미로 나눈다", () => {
    // 말한 것을 받아적으면 부호가 없는 경우가 대부분이다.
    const spans = splitSentences("열이 났어요 노티했어요 지켜보자고 하셨어요");
    expect(spans.map((s) => s.text)).toEqual([
      "열이 났어요",
      "노티했어요",
      "지켜보자고 하셨어요",
    ]);
  });

  it("연결어미는 자르지 않는다", () => {
    // "했다고"의 어절 끝은 '고'다. 어절 끝만 보면 연결어미가 저절로 걸러진다.
    expect(splitSentences("열 났다고 했어요").map((s) => s.text)).toEqual([
      "열 났다고 했어요",
    ]);
    expect(splitSentences("아프다고 하셔서 진통제 드렸어요").map((s) => s.text)).toEqual([
      "아프다고 하셔서 진통제 드렸어요",
    ]);
  });

  it("인용조사 없이 이어지는 말도 안 자른다", () => {
    // "아프다 하셔서" — 형태소 분석 없이는 애매한 자리다.
    // 뒤에 이어받는 말이 오면 자르지 않는 것으로 처리한다.
    expect(splitSentences("환자분이 아프다 하셔서 봤어요").map((s) => s.text)).toEqual([
      "환자분이 아프다 하셔서 봤어요",
    ]);
    expect(splitSentences("소변량 적다 그래서 노티했어요").map((s) => s.text)).toEqual([
      "소변량 적다 그래서 노티했어요",
    ]);
  });

  it("명사 끝 글자를 종결어미로 착각하지 않는다", () => {
    // 처음 만들 때 -지 -자 -네 -라 -니 를 다 종결어미로 넣었다가 바로 깨졌다.
    // 한국어에서 아주 흔한 명사들이 그 글자로 끝난다.
    expect(splitSentences("폴리 유지 중이에요").map((s) => s.text)).toEqual([
      "폴리 유지 중이에요",
    ]);
    expect(splitSentences("환자 상태 봤어요").map((s) => s.text)).toEqual([
      "환자 상태 봤어요",
    ]);
    expect(splitSentences("보호자 오셨어요").map((s) => s.text)).toEqual(["보호자 오셨어요"]);
    expect(splitSentences("교대 시간 됐어요").map((s) => s.text)).toEqual(["교대 시간 됐어요"]);
  });

  it("한 글자 어미의 예외도 안 자른다", () => {
    // "필요"는 '요'로 끝나지만 문장 끝이 아니다.
    expect(splitSentences("산소 필요 없어요").map((s) => s.text)).toEqual([
      "산소 필요 없어요",
    ]);
    expect(splitSentences("중요 사항 알려드릴게요").map((s) => s.text)).toEqual([
      "중요 사항 알려드릴게요",
    ]);
  });

  it("글자를 하나도 잃지 않는다", () => {
    // 이 성질이 깨지면 화면 하이라이트와 교정 위치가 전부 어긋난다.
    const input = "네 인계 시작할게요 301호 김씨 어제 수술하셨고 오늘 열 났어요";
    const spans = splitSentences(input);
    for (const s of spans) {
      expect(input.slice(s.start, s.end)).toBe(s.text);
    }
    expect(spans.map((s) => s.text).join(" ")).toBe(input);
  });

  it("위치가 겹치지 않고 순서대로다", () => {
    const spans = splitSentences("열 났어요 노티했어요 지켜봅니다");
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });

  it("긴 인계 한 덩어리를 문장으로 편다", () => {
    const handover =
      "네 그럼 인계 시작할게요 어제 수술하셨고 오늘 아침에 열 났어요 " +
      "노티했는데 일단 지켜보자고 하셨어요 폴리 유지 중이고 소변량 괜찮아요";
    const spans = splitSentences(handover);
    expect(spans.length).toBeGreaterThan(2);
    expect(spans.map((s) => s.text).join(" ")).toBe(handover);
  });
});

describe("세그먼트를 문장 세그먼트로", () => {
  it("한 문장이면 원본을 그대로 돌려준다", () => {
    const s = seg({ text: "폴리 유지 중이에요" });
    expect(splitSegmentIntoSentences(s)).toEqual([s]);
  });

  it("id에 순번을 붙인다", () => {
    const out = splitSegmentIntoSentences(seg({ text: "열 났어요 노티했어요" }));
    expect(out.map((s) => s.id)).toEqual(["r1#s0.0", "r1#s0.1"]);
  });

  it("시각이 순서대로 늘어나고 원본 구간을 벗어나지 않는다", () => {
    const out = splitSegmentIntoSentences(
      seg({ text: "열 났어요 노티했어요 지켜봅니다", startSec: 10, endSec: 20 }),
    );
    expect(out[0].startSec).toBe(10);
    expect(out[out.length - 1].endSec).toBe(20);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startSec).toBeGreaterThanOrEqual(out[i - 1].startSec);
      expect(out[i].endSec).toBeLessThanOrEqual(20);
    }
  });

  it("화자를 그대로 물려준다", () => {
    // 화자분리는 소리로 하는 것이라 한 세그먼트 안에서 갈리지 않는다.
    const out = splitSegmentIntoSentences(
      seg({ text: "열 났어요 노티했어요", speakerId: "spk_1", speakerRole: "senior" }),
    );
    expect(out.every((s) => s.speakerId === "spk_1")).toBe(true);
    expect(out.every((s) => s.speakerRole === "senior")).toBe(true);
  });

  it("짧은 맞장구는 앞 문장에 붙인다", () => {
    // "네"가 문장 하나씩 차지하면 목록이 못 쓰게 된다.
    const out = splitSegmentIntoSentences(seg({ text: "열이 났어요 네 노티했어요" }));
    expect(out.every((s) => s.text.trim().length >= 4)).toBe(true);
  });

  it("맞장구를 붙이면서도 글자를 잃지 않는다", () => {
    const text = "네 열이 났어요 네 노티했어요";
    const out = splitSegmentIntoSentences(seg({ text }));
    expect(out.map((s) => s.text).join(" ")).toBe(text);
  });

  it("교정 전이면 rawText도 같이 나눈다", () => {
    const out = splitSegmentIntoSentences(
      seg({ text: "열 났어요 노티했어요", rawText: "열 났어요 노티했어요" }),
    );
    expect(out[0].rawText).toBe(out[0].text);
  });

  it("이미 교정된 세그먼트면 rawText를 통째로 남긴다", () => {
    // 길이가 달라 같은 자리에서 자를 수 없다. 자르면 엉뚱한 데서 잘린다.
    const out = splitSegmentIntoSentences(
      seg({ text: "열 났어요 노티했어요", rawText: "열 났어요 노디했어요" }),
    );
    expect(out[0].rawText).toBe("열 났어요 노디했어요");
  });

  it("여러 세그먼트를 한 번에 편다", () => {
    const out = splitAllIntoSentences([
      seg({ id: "a", text: "열 났어요 노티했어요" }),
      seg({ id: "b", text: "폴리 유지 중이에요" }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["a.0", "a.1", "b"]);
  });
});
