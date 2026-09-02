import { describe, it, expect } from "vitest";
import { findRepetitions, reviewTranscript } from "../src/transcription/review.js";
import { createMemory, recordCorrection } from "../src/transcription/learn.js";

describe("반복 환각 탐지", () => {
  it("같은 어절이 3회 이상 연속되면 잡는다", () => {
    const text = "네 네 네 네 알겠습니다";
    const r = findRepetitions(text);
    expect(r).toHaveLength(1);
    expect(r[0].unit).toBe("네");
    expect(r[0].count).toBe(4);
    expect(text.slice(r[0].start, r[0].end)).toBe("네 네 네 네");
  });

  it("여러 어절짜리 구가 반복되어도 잡는다", () => {
    const text = "소변량 확인해 주세요 소변량 확인해 주세요 소변량 확인해 주세요";
    const r = findRepetitions(text);
    expect(r).toHaveLength(1);
    expect(r[0].unit).toBe("소변량 확인해 주세요");
    expect(r[0].count).toBe(3);
  });

  it("띄어쓰기 없이 붙어 반복된 것도 잡는다", () => {
    const r = findRepetitions("감사합니다감사합니다감사합니다 네");
    expect(r).toHaveLength(1);
    expect(r[0].unit).toBe("감사합니다");
    expect(r[0].count).toBe(3);
  });

  it("두 번 반복은 잡지 않는다 — 실제 발화일 수 있다", () => {
    expect(findRepetitions("네 네 알겠습니다")).toHaveLength(0);
  });

  it("반복이 없으면 빈 배열", () => {
    expect(findRepetitions("폴리 유지 중이고 소변량 괜찮아요")).toHaveLength(0);
  });
});

describe("전사 검토 — 판정 분류", () => {
  it("사전에 등록된 오인식 교정은 auto 로 분류한다", () => {
    const { items } = reviewTranscript("노디 먼저 드려");
    const item = items.find((i) => i.entryId === "notify");
    expect(item?.verdict).toBe("auto");
    expect(item?.kind).toBe("misheard");
    expect(item?.surface).toBe("노디");
    expect(item?.suggestion).toBe("노티");
  });

  it("약어 한글 읽기 변환은 auto", () => {
    const { items } = reviewTranscript("브이에스 체크했어?");
    const item = items.find((i) => i.kind === "initialism");
    expect(item?.verdict).toBe("auto");
    expect(item?.suggestion).toBe("V/S");
  });

  it("발음 매칭 교정 중 신뢰도가 아주 높은 것은 auto, 애매한 것은 check", () => {
    // 드레씽↔드레싱 0.957 → auto
    const high = reviewTranscript("드레씽 다시 했어요").items.find((i) => i.kind === "phonetic");
    expect(high?.verdict).toBe("auto");
    // 임계↔인계 0.94 → check (2음절은 우연히 걸릴 확률이 높다)
    const mid = reviewTranscript("임계 끝나고 얘기해요").items.find((i) => i.kind === "phonetic");
    expect(mid?.verdict).toBe("check");
    expect(mid?.suggestion).toBe("인계");
  });

  it("교정 문턱에는 못 미치지만 사전 용어와 발음이 가까운 말은 ask 후보로 올린다", () => {
    // 석숀↔석션 0.842. 교정기는 손대지 않지만 사람이 볼 후보다.
    const { items, text } = reviewTranscript("석숀 한 번 더 해주세요");
    expect(text).toContain("석숀"); // 자동으로 바꾸지 않는다
    const item = items.find((i) => i.kind === "unknown-term");
    expect(item?.verdict).toBe("ask");
    expect(item?.surface).toBe("석숀");
    expect(item?.suggestion).toBe("석션");
    expect(item?.entryId).toBe("suction");
  });

  it("사전에 없는 약어 읽기는 ask 로 올린다", () => {
    const { items } = reviewTranscript("티오티 확인했어요");
    const item = items.find((i) => i.kind === "unknown-initialism");
    expect(item?.verdict).toBe("ask");
    expect(item?.surface).toBe("티오티");
    expect(item?.suggestion).toContain("TOT");
  });

  it("문맥에 따라 뜻이 갈리는 약어는 check 로 표시한다", () => {
    const { items } = reviewTranscript("디씨 났어요");
    const item = items.find((i) => i.kind === "ambiguous");
    expect(item?.verdict).toBe("check");
    expect(item?.reason).toContain("문맥");
  });

  it("반복 구간은 ask 로 올리고 문장을 함께 준다", () => {
    const { items } = reviewTranscript("네 네 네 네 알겠습니다");
    const rep = items.find((i) => i.kind === "repetition");
    expect(rep?.verdict).toBe("ask");
    expect(rep?.suggestion).toBe("네");
    expect(rep?.sentence).toContain("네 네 네 네");
  });

  it("흔한 일반어가 사전 용어와 발음이 가까운 경우는 묻지 않고 확인 목록에만 둔다", () => {
    // 내일↔레일(침상난간) 0.88. 사용자에게 물으면 잡음이다. 문맥을 읽는 쪽이 판단한다.
    const { items } = reviewTranscript("내일 집에 가신대요");
    const item = items.find((i) => i.kind === "unknown-term");
    expect(item?.verdict).toBe("check");
    expect(item?.surface).toBe("내일");
    expect(items.filter((i) => i.verdict === "ask")).toHaveLength(0);
  });

  it("일반 한국어 문장에서는 후보를 만들지 않는다", () => {
    const { items } = reviewTranscript("오늘 점심 뭐 먹을까요");
    expect(items.filter((i) => i.verdict === "ask")).toHaveLength(0);
  });
});

describe("전사 검토 — 결과 조립", () => {
  it("문장별 교정본을 원문 순서대로 이어 붙인다", () => {
    const { text, sentences } = reviewTranscript("노디 먼저 드려. 브이에스 체크했어?");
    expect(text).toBe("노티 먼저 드려. V/S 체크했어?");
    expect(sentences).toHaveLength(2);
    expect(sentences[0].raw).toBe("노디 먼저 드려.");
    expect(sentences[0].text).toBe("노티 먼저 드려.");
  });

  it("각 항목은 자기 문장을 가리킨다", () => {
    const { items } = reviewTranscript("노디 먼저 드려. 브이에스 체크했어?");
    expect(items.find((i) => i.kind === "misheard")?.sentenceIndex).toBe(0);
    expect(items.find((i) => i.kind === "initialism")?.sentenceIndex).toBe(1);
  });

  it("확정된 교정 이력이 있으면 사전보다 먼저 적용하고 learned 로 표시한다", () => {
    let memory = createMemory(2);
    memory = recordCorrection(memory, "석숀", "석션", 1);
    memory = recordCorrection(memory, "석숀", "석션", 2);
    const { text, items } = reviewTranscript("석숀 한 번 더 해주세요", { memory });
    expect(text).toContain("석션");
    const learned = items.find((i) => i.kind === "learned");
    expect(learned?.verdict).toBe("auto");
    // 이미 확정된 것은 다시 묻지 않는다
    expect(items.filter((i) => i.kind === "unknown-term")).toHaveLength(0);
  });
});
