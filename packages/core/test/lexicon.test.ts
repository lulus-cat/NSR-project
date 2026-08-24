import { describe, it, expect } from "vitest";
import { defaultLexicon, buildLexicon, BUILTIN_TERMS } from "../src/lexicon/index.js";
import { correctTranscript } from "../src/transcription/index.js";

describe("사전 무결성", () => {
  it("id가 중복되지 않는다", () => {
    const ids = BUILTIN_TERMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("모든 항목에 정의가 있다", () => {
    for (const t of BUILTIN_TERMS) {
      expect(t.definition.length, `${t.id}에 정의 없음`).toBeGreaterThan(5);
    }
  });
  it("은어 표시가 있으면 공식 표현도 있다", () => {
    for (const t of BUILTIN_TERMS) {
      if (t.informal) expect(t.formal, `${t.id}에 formal 없음`).toBeTruthy();
    }
  });
});

describe("조회", () => {
  it("표기 그대로 찾는다", () => {
    const hit = defaultLexicon.lookup("석션");
    expect(hit?.entry.id).toBe("suction");
    expect(hit?.via).toBe("exact");
  });
  it("현장 변이형을 찾는다", () => {
    expect(defaultLexicon.lookup("썩션")?.entry.id).toBe("suction");
    expect(defaultLexicon.lookup("폴리")?.entry.id).toBe("foley-catheter");
  });
  it("영문 약어를 찾는다", () => {
    expect(defaultLexicon.lookup("DNR")?.entry.id).toBe("dnr");
    expect(defaultLexicon.lookup("npo")?.entry.id).toBe("npo");
  });
  it("한글로 읽은 약어를 복원해 찾는다", () => {
    const hit = defaultLexicon.lookup("브이에스");
    expect(hit?.entry.id).toBe("vital-sign");
  });
  it("발음이 같은 오표기를 찾는다", () => {
    const hit = defaultLexicon.lookup("사비빕");
    expect(hit).toBeNull();
    expect(defaultLexicon.lookup("노디")?.entry.id).toBe("notify");
  });
  it("무관한 말은 못 찾는다", () => {
    expect(defaultLexicon.lookup("점심메뉴")).toBeNull();
  });
});

describe("검체·용기 은어", () => {
  it.each([
    ["바틀", "culture-bottle"],
    ["보틀", "culture-bottle"],
    ["컬쳐", "culture-sensitivity"],
    ["퍼플튜브", "edta-tube"],
    ["유린백", "urine-bag"],
    ["드레싱셋", "dressing-set"],
    ["노멀세이린", "normal-saline-slang"],
    ["떡쳤다", "swamped"],
  ])("%s → %s", (spoken, id) => {
    expect(defaultLexicon.lookup(spoken)?.entry.id).toBe(id);
  });

  it("문장 안에서 바틀을 잡아낸다", () => {
    const r = correctTranscript("혈액배양 바틀 두 개 나갔고 컬쳐 결과는 아직이에요");
    expect(r.termIds).toContain("culture-bottle");
    expect(r.termIds).toContain("culture-sensitivity");
  });

  it("완곡어도 뜻을 알려준다", () => {
    const entry = defaultLexicon.lookup("내려요")?.entry;
    expect(entry?.id).toBe("transfer-up-down");
    expect(entry?.definition).toContain("사망");
  });
});

describe("검색", () => {
  it("부분 일치로 찾는다", () => {
    const results = defaultLexicon.search("정맥");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === "central-line")).toBe(true);
  });
  it("정의 본문으로도 찾는다", () => {
    expect(defaultLexicon.search("욕창").length).toBeGreaterThan(0);
  });
});

describe("사용자 사전", () => {
  it("사용자 항목이 내장 항목을 덮어쓴다", () => {
    const lex = buildLexicon([
      {
        id: "suction",
        ko: "우리병동석션",
        aliases: ["우리석션"],
        category: "procedure",
        definition: "병동 자체 정의",
      },
    ]);
    expect(lex.get("suction")?.ko).toBe("우리병동석션");
    expect(lex.lookup("우리석션")?.entry.id).toBe("suction");
  });
});
