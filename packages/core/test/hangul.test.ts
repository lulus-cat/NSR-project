import { describe, it, expect } from "vitest";
import {
  splitSyllable,
  joinSyllable,
  toJamo,
  pronounce,
  soundsSame,
  phoneticSimilarity,
  expandInitialism,
} from "../src/hangul/index.js";

describe("자모 분해/결합", () => {
  it("받침 있는 음절을 초/중/종성으로 나눈다", () => {
    expect(splitSyllable("한")).toEqual({ cho: "ㅎ", jung: "ㅏ", jong: "ㄴ" });
  });
  it("받침 없는 음절은 종성이 빈 문자열", () => {
    expect(splitSyllable("가")).toEqual({ cho: "ㄱ", jung: "ㅏ", jong: "" });
  });
  it("분해와 결합은 서로의 역연산", () => {
    for (const ch of "간호사기록폴리흡인각막쌍괜") {
      const s = splitSyllable(ch);
      expect(s).not.toBeNull();
      expect(joinSyllable(s!)).toBe(ch);
    }
  });
  it("한글이 아닌 문자는 그대로 통과", () => {
    expect(toJamo("V/S 체크")).toContain("V");
    expect(toJamo("V/S 체크")).toContain("/");
  });
});

describe("음운 규칙", () => {
  it("연음", () => {
    expect(pronounce("입원")).toBe("이붠");
    expect(pronounce("삽입")).toBe("사빕");
  });
  it("경음화", () => {
    expect(pronounce("낙상")).toBe("낙쌍");
  });
  it("비음화", () => {
    expect(pronounce("입니다")).toBe("임니다");
    expect(pronounce("작년")).toBe("장년");
  });
  it("유음화", () => {
    expect(pronounce("신라")).toBe("실라");
  });
  it("격음화", () => {
    expect(pronounce("축하")).toBe("추카");
    expect(pronounce("좋고")).toBe("조코");
  });
  it("종성 중화", () => {
    expect(pronounce("밖")).toBe("박");
    expect(pronounce("옷")).toBe("옫");
  });
});

describe("발음 동일성", () => {
  it("ASR이 소리대로 적은 표기를 원 표기와 같게 본다", () => {
    expect(soundsSame("폴리 삽입", "폴리 사빕")).toBe(true);
    expect(soundsSame("낙상", "낙쌍")).toBe(true);
  });
  it("다른 단어는 다르게 본다", () => {
    expect(soundsSame("낙상", "간호")).toBe(false);
  });
});

describe("발음 유사도", () => {
  it("헷갈리기 쉬운 자모 차이는 유사도가 높다", () => {
    expect(phoneticSimilarity("카데타", "카테터")).toBeGreaterThan(0.75);
    expect(phoneticSimilarity("노디", "노티")).toBeGreaterThan(0.85);
  });
  it("무관한 단어는 유사도가 낮다", () => {
    expect(phoneticSimilarity("카데타", "간호사")).toBeLessThan(0.5);
  });
  it("동일 문자열은 1", () => {
    expect(phoneticSimilarity("석션", "석션")).toBe(1);
  });
});

describe("약어 한글 읽기 복원", () => {
  it("알파벳 읽기를 조합해 약어 후보를 만든다", () => {
    expect(expandInitialism("디엔알")).toContain("DNR");
    expect(expandInitialism("브이에스")).toContain("VS");
    expect(expandInitialism("에이비지에이")).toContain("ABGA");
    expect(expandInitialism("씨피알")).toContain("CPR");
  });
  it("알파벳 읽기가 아닌 말은 후보가 없다", () => {
    expect(expandInitialism("간호사")).toEqual([]);
  });
  it("한 글자짜리는 만들지 않는다", () => {
    expect(expandInitialism("오")).toEqual([]);
  });
});
