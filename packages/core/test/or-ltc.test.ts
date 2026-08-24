import { describe, it, expect } from "vitest";
import {
  defaultLexicon,
  OR_TERMS,
  LTC_TERMS,
  OR_LTC_TERMS,
  BUILTIN_TERMS,
  surfacesOf,
} from "../src/lexicon/index.js";
import { normalizeForCompare } from "../src/hangul/phonology.js";
import { correctTranscript } from "../src/transcription/index.js";

describe("수술실·요양병원 용어가 사전에 들어와 있다", () => {
  it("두 묶음이 합쳐진 것이 OR_LTC_TERMS다", () => {
    expect(OR_LTC_TERMS.length).toBe(OR_TERMS.length + LTC_TERMS.length);
  });

  it("모든 항목이 기본 사전에서 id로 조회된다", () => {
    for (const term of OR_LTC_TERMS) {
      expect(defaultLexicon.get(term.id), `${term.id} 없음`).toBeTruthy();
    }
  });

  it("모든 항목에 정의가 있다", () => {
    for (const term of OR_LTC_TERMS) {
      expect(term.definition.length, `${term.id}에 정의 없음`).toBeGreaterThan(5);
    }
  });

  it("은어로 표시한 것에는 공식 표현이 붙어 있다", () => {
    for (const term of OR_LTC_TERMS) {
      if (term.informal) expect(term.formal, `${term.id}에 formal 없음`).toBeTruthy();
    }
  });
});

describe("표면형이 서로를 가리지 않는다", () => {
  /**
   * 같은 표기를 두 항목이 가지면 **앞선 항목이 뒤를 영구히 가린다.**
   * 조용히 일어나기 때문에 테스트로 잡지 않으면 알 방법이 없다.
   * 실제로 이 테스트를 쓰면서 "배회"가 BPSD에 묶여 배회 항목이
   * 한 번도 안 잡히던 것을 발견했다.
   */
  it("새 용어의 표기가 기존 항목과 겹치지 않는다", () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const entry of BUILTIN_TERMS) {
      for (const surface of surfacesOf(entry)) {
        const key = normalizeForCompare(surface);
        if (!key) continue;
        const prev = owner.get(key);
        if (!prev) {
          owner.set(key, entry.id);
          continue;
        }
        if (prev === entry.id) continue;
        const involved = [prev, entry.id].some(
          (id) => id.startsWith("or-") || id.startsWith("ltc-"),
        );
        if (involved) clashes.push(`"${surface}": ${prev} ↔ ${entry.id}`);
      }
    }
    expect(clashes, clashes.join("\n")).toEqual([]);
  });
});

describe("수술실에서 실제로 하는 말", () => {
  it("카운트를 찾는다", () => {
    expect(defaultLexicon.lookup("카운트")?.entry.id).toBe("or-count");
  });

  it("보비는 전기소작기로 이어진다", () => {
    const hit = defaultLexicon.lookup("보비");
    expect(hit?.entry.id).toBe("or-bovie");
    expect(hit?.entry.formal).toBe("전기수술기");
  });

  it("프렙·드레이핑·클로징 같은 현장 표기가 다 걸린다", () => {
    expect(defaultLexicon.lookup("프렙")?.entry.id).toBe("or-prep");
    expect(defaultLexicon.lookup("드레이핑")?.entry.id).toBe("or-draping");
    expect(defaultLexicon.lookup("클로징")?.entry.id).toBe("or-closing");
  });

  it("타임아웃에는 왜 중요한지가 적혀 있다", () => {
    expect(defaultLexicon.get("or-timeout")?.pitfall).toContain("부위");
  });

  it("카운트가 안 맞으면 어떻게 되는지 적혀 있다", () => {
    expect(defaultLexicon.get("or-count")?.pitfall).toContain("봉합");
  });
});

describe("요양병원에서 실제로 하는 말", () => {
  it("와상·연하곤란·구축을 찾는다", () => {
    expect(defaultLexicon.lookup("와상")?.entry.id).toBe("ltc-bedridden");
    expect(defaultLexicon.lookup("연하곤란")?.entry.id).toBe("ltc-dysphagia");
    expect(defaultLexicon.lookup("구축")?.entry.id).toBe("ltc-contracture");
  });

  it("배회는 BPSD가 아니라 배회 항목으로 간다", () => {
    expect(defaultLexicon.lookup("배회")?.entry.id).toBe("ltc-wandering");
  });

  it("BPSD는 한글 읽기로도 걸린다", () => {
    expect(defaultLexicon.lookup("비피에스디")?.entry.id).toBe("ltc-bpsd");
  });

  it("요보사는 요양보호사로 이어진다", () => {
    expect(defaultLexicon.lookup("요보사")?.entry.id).toBe("ltc-caregiver");
  });

  it("'선생님'은 요양보호사로 붙지 않는다", () => {
    // 병원에서 "선생님"은 의사·간호사·요양보호사 아무에게나 쓰인다.
    expect(defaultLexicon.lookup("선생님")?.entry.id).not.toBe("ltc-caregiver");
  });

  it("촉탁의는 상주가 아니라는 점이 적혀 있다", () => {
    expect(defaultLexicon.get("ltc-visiting-doctor")?.pitfall).toContain("방문");
  });

  it("요양보호사 항목에 업무 위임 한계가 적혀 있다", () => {
    expect(defaultLexicon.get("ltc-caregiver")?.pitfall).toContain("투약");
  });
});

describe("전사 교정이 새 용어를 다룬다", () => {
  it("수술실 대화에서 용어를 짚어낸다", () => {
    const result = correctTranscript("클로징 전에 카운트 맞춰주세요", {
      lexicon: defaultLexicon,
    });
    const ids = result.annotations.map((a) => a.entryId);
    expect(ids).toContain("or-closing");
    expect(ids).toContain("or-count");
  });

  it("맞게 말한 것은 고치지 않는다", () => {
    // 교정기의 원칙: 음성인식 오류만 고치고 사람이 한 말은 건드리지 않는다.
    const text = "와상 환자분 연하곤란 있어서 점도 올렸어요";
    expect(correctTranscript(text, { lexicon: defaultLexicon }).text).toBe(text);
  });
});
