import { describe, it, expect } from "vitest";
import {
  correctTranscript,
  buildInitialPrompt,
  buildHotwords,
  buildKeywordBoosting,
  estimateWhisperTokens,
  WHISPER_PROMPT_TOKEN_LIMIT,
  createMemory,
  recordCorrection,
  lookupLearned,
  pendingRules,
  pruneMemory,
  deidentify,
} from "../src/transcription/index.js";
import { defaultLexicon } from "../src/lexicon/index.js";

describe("전사 교정", () => {
  it("한글로 읽은 약어를 영문 약어로 되돌린다", () => {
    const r = correctTranscript("브이에스 체크했어?");
    expect(r.text).toContain("V/S");
    expect(r.edits[0]?.reason).toBe("initialism");
  });

  it("화자가 실제로 쓴 은어는 바꾸지 않고 주석만 단다", () => {
    const r = correctTranscript("폴리 소변량 확인해");
    expect(r.text).toContain("폴리");
    expect(r.text).not.toContain("유치도뇨관");
    expect(r.termIds).toContain("foley-catheter");
    expect(r.edits.filter((e) => e.entryId === "foley-catheter")).toHaveLength(0);
  });

  it("사전에 등록된 오인식 표기를 원래 말로 되돌린다", () => {
    const r = correctTranscript("노디 먼저 드려");
    expect(r.text).toContain("노티");
    expect(r.edits.find((e) => e.entryId === "notify")?.reason).toBe("misheard");
  });

  it("사전에 없는 오인식도 발음이 충분히 가까우면 교정한다", () => {
    const r = correctTranscript("드레씽 다시 했어요");
    expect(r.text).toContain("드레싱");
    expect(r.edits.find((e) => e.entryId === "dressing")?.reason).toBe("phonetic");
  });

  it("오인식 교정의 목적지는 다른 오인식 표기가 아니다", () => {
    // "포리"(오인식) → "폴리"(실제 발화)로 가야지 "폴리카데터"(오인식)로 가면 안 된다.
    const r = correctTranscript("포리 유지 중이에요");
    expect(r.text).toContain("폴리");
    expect(r.text).not.toContain("카데");
  });

  it("조사가 붙은 어절에서도 용어를 찾는다", () => {
    const r = correctTranscript("석션을 먼저 하고 드레싱했어요");
    expect(r.termIds).toContain("suction");
    expect(r.termIds).toContain("dressing");
  });

  it("원문을 항상 보존한다", () => {
    const input = "브이에스 체크";
    const r = correctTranscript(input);
    expect(r.original).toBe(input);
    expect(r.text).not.toBe(input);
  });

  it("abbreviationStyle keep이면 원문 표기를 유지한다", () => {
    const r = correctTranscript("브이에스 체크", { abbreviationStyle: "keep" });
    expect(r.text).toContain("브이에스");
    expect(r.edits).toHaveLength(0);
    expect(r.termIds).toContain("vital-sign");
  });

  it("사전에 없는 문장은 그대로 둔다", () => {
    const input = "오늘 점심 뭐 먹었어요";
    expect(correctTranscript(input).text).toBe(input);
  });

  it("주석 위치가 교정 후 텍스트를 정확히 가리킨다", () => {
    const r = correctTranscript("아침에 브이에스 체크하고 석션했어요");
    for (const ann of r.annotations) {
      expect(r.text.slice(ann.start, ann.end)).toBe(ann.surface);
    }
  });

  it("여러 용어가 든 인계 문장을 처리한다", () => {
    const r = correctTranscript(
      "엔피오 유지하고 아이오 정확히 재고 디엔알 동의서 확인해주세요",
    );
    expect(r.termIds).toEqual(
      expect.arrayContaining(["npo", "intake-output", "dnr"]),
    );
  });
});

describe("Whisper 프롬프트 생성", () => {
  it("토큰 예산을 넘지 않는다", () => {
    const prompt = buildInitialPrompt(defaultLexicon);
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(
      WHISPER_PROMPT_TOKEN_LIMIT,
    );
  });

  it("사용 이력이 있는 용어를 뒤쪽(=살아남는 자리)에 배치한다", () => {
    const prompt = buildInitialPrompt(defaultLexicon, {
      usageCounts: { "night-shift": 50 },
    });
    expect(prompt).toContain("나이트");
  });

  it("pinned 용어는 반드시 포함된다", () => {
    const prompt = buildInitialPrompt(defaultLexicon, { pinned: ["braden-scale"] });
    expect(prompt).toContain("욕창위험 사정도구");
  });

  it("hotwords는 상한을 지킨다", () => {
    expect(buildHotwords(defaultLexicon, { limit: 10 })).toHaveLength(10);
  });
});

describe("사용자 교정 학습", () => {
  it("최소 횟수를 넘어야 자동 적용된다", () => {
    let m = createMemory(2);
    m = recordCorrection(m, "쎅션", "석션", 1);
    expect(lookupLearned(m)).toHaveLength(0);
    expect(pendingRules(m)).toHaveLength(1);
    m = recordCorrection(m, "쎅션", "석션", 2);
    expect(lookupLearned(m)).toHaveLength(1);
  });

  it("학습된 규칙이 교정에 적용된다", () => {
    let m = createMemory(2);
    m = recordCorrection(m, "완전실", "환자실", 1);
    m = recordCorrection(m, "완전실", "환자실", 2);
    const r = correctTranscript("완전실 정리해주세요", { memory: m });
    expect(r.text).toContain("환자실");
    expect(r.edits.some((e) => e.reason === "learned")).toBe(true);
  });

  it("문장 길이의 교정은 규칙으로 학습하지 않는다", () => {
    const m = recordCorrection(
      createMemory(1),
      "오늘 근무 중에 있었던 모든 일을 정리해주세요",
      "정리",
      1,
    );
    expect(Object.keys(m.rules)).toHaveLength(0);
  });

  it("오래된 규칙을 정리한다", () => {
    let m = createMemory(1);
    m = recordCorrection(m, "가", "나", 1000);
    m = recordCorrection(m, "다", "라", 9000);
    const pruned = pruneMemory(m, { olderThan: 5000 });
    expect(Object.keys(pruned.rules)).toHaveLength(1);
  });
});

describe("비식별화", () => {
  it("등록번호·전화번호·이름 앞 호칭을 가린다", () => {
    const r = deidentify("김영희님 등록번호 12345678, 연락처 010-1234-5678");
    expect(r.text).toContain("[이름]");
    expect(r.text).toContain("[등록번호]");
    expect(r.text).toContain("[전화번호]");
    expect(r.redactedCount).toBeGreaterThanOrEqual(3);
  });
});

describe("상용 엔진 키워드 부스팅", () => {
  it("한글 형태만 내보낸다", () => {
    // 상용 엔진의 부스팅은 한국어만 받고, 애초에 오디오에 영문 약어 소리는 없다.
    for (const k of buildKeywordBoosting(defaultLexicon, { limit: 300 })) {
      expect(/[가-힣]/.test(k.keyword), `한글 아님: ${k.keyword}`).toBe(true);
    }
  });

  it("약어는 한국어 읽기형으로 바꿔 넣는다", () => {
    const keywords = buildKeywordBoosting(defaultLexicon).map((k) => k.keyword);
    expect(keywords).toContain("에이비지에이");
    expect(keywords).not.toContain("ABGA");
  });

  it("중복 없이 상한을 지킨다", () => {
    const k = buildKeywordBoosting(defaultLexicon, { limit: 50 });
    expect(k).toHaveLength(50);
    expect(new Set(k.map((x) => x.keyword)).size).toBe(50);
  });

  it("자주 나온 용어에만 가중치를 올린다", () => {
    const k = buildKeywordBoosting(defaultLexicon, {
      usageCounts: { "night-shift": 20 },
    });
    expect(k.find((x) => x.keyword === "나이트")?.weight).toBe(3);
    // 이력이 없는 것은 기본 가중치 그대로. 세게 주면 없는 말을 만들어낸다.
    expect(k.find((x) => x.keyword === "브레이든")?.weight).toBe(1);
  });
});
