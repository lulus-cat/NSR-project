import { describe, it, expect } from "vitest";
import {
  createWardPack,
  scanPackForPii,
  describePackFindings,
  type WardPack,
} from "../src/lexicon/index.js";

function pack(over: Partial<WardPack> = {}): WardPack {
  return {
    ...createWardPack({ id: "test-ward", name: "테스트병원 71병동", now: 0 }),
    ...over,
  };
}

describe("병동 사전 개인정보 검사", () => {
  it("깨끗한 사전에서는 아무것도 안 잡는다", () => {
    const p = pack({
      terms: [
        {
          id: "w1",
          ko: "노티",
          aliases: ["노티하다"],
          category: "documentation",
          definition: "의사에게 환자 상태 변화를 알리는 것.",
          pitfall: "무엇을 언제 알렸는지 기록에 남긴다.",
        },
      ],
    });
    expect(scanPackForPii(p)).toEqual([]);
  });

  it("정의에 섞여 들어간 환자 이름을 짚어낸다", () => {
    const p = pack({
      terms: [
        {
          id: "w1",
          ko: "드레싱",
          aliases: [],
          category: "procedure",
          definition: "상처를 소독하고 덮는 것. 김영희님 드레싱할 때 쓰는 말.",
        },
      ],
    });
    const found = scanPackForPii(p);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].kind).toBe("name");
    expect(found[0].termId).toBe("w1");
    expect(found[0].where).toContain("정의");
  });

  it("전화번호를 짚어낸다", () => {
    const p = pack({ note: "궁금하면 010-1234-5678로 연락 주세요" });
    const found = scanPackForPii(p);
    expect(found.some((f) => f.kind === "phone")).toBe(true);
    expect(found[0].termId).toBeNull();
  });

  it("사전에서는 병실 번호도 잡는다", () => {
    // 전사본에서는 임상적으로 필요해 기본으로 꺼 두지만,
    // 용어 설명에 병실 번호가 들어갈 이유는 없다.
    const p = pack({
      terms: [
        {
          id: "w1",
          ko: "옆방",
          aliases: [],
          category: "workflow",
          definition: "302호실 2번 침상을 가리키는 말.",
        },
      ],
    });
    expect(scanPackForPii(p).some((f) => f.kind === "location")).toBe(true);
  });

  it("치환 규칙에 남은 이름도 잡는다", () => {
    // 오인식 교정 이력에서 자란 치환 규칙에는 환자 이름이 그대로 남기 쉽다.
    const p = pack({ corrections: [{ from: "김영희씨", to: "김영희님" }] });
    expect(scanPackForPii(p).some((f) => f.kind === "name")).toBe(true);
  });

  it("어느 문장에서 나왔는지 함께 준다", () => {
    // 앞뒤를 봐야 오탐인지 안다. 걸린 말만 보여주면 판단할 수 없다.
    const p = pack({
      terms: [
        {
          id: "w1",
          ko: "라운딩",
          aliases: [],
          category: "workflow",
          definition: "회진. 박민수님 방부터 돕니다.",
        },
      ],
    });
    const found = scanPackForPii(p);
    expect(found[0].context).toContain("회진");
  });

  it("사전을 고치지 않는다 — 찾아서 보여주기만 한다", () => {
    // 자동으로 지우면 문장이 망가진다. 다시 써야 하는 것이지 지워야 하는 게 아니다.
    const definition = "상처 소독. 김영희님 것.";
    const p = pack({
      terms: [{ id: "w1", ko: "드레싱", aliases: [], category: "procedure", definition }],
    });
    scanPackForPii(p);
    expect(p.terms[0].definition).toBe(definition);
  });

  it("아무것도 없어도 그냥 넘어가라고 하지 않는다", () => {
    expect(describePackFindings([])).toContain("훑어보고");
  });

  it("찾았을 때는 오탐 가능성을 함께 말한다", () => {
    const p = pack({ note: "010-1234-5678" });
    const message = describePackFindings(scanPackForPii(p));
    expect(message).toContain("직접 보고 판단");
  });
});
