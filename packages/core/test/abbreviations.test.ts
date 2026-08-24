import { describe, it, expect } from "vitest";
import {
  ALL_ABBREVS,
  BUILTIN_TERMS,
  defaultLexicon,
  surfacesOf,
} from "../src/lexicon/index.js";
import { toHangulReading, expandInitialism } from "../src/hangul/index.js";
import { correctTranscript } from "../src/transcription/index.js";

describe("약어 되읽기", () => {
  it("영문 약어를 한국어 발음형으로 바꾼다", () => {
    expect(toHangulReading("ABGA")).toBe("에이비지에이");
    expect(toHangulReading("DNR")).toBe("디엔알");
    expect(toHangulReading("V/S")).toBe("브이에스");
    expect(toHangulReading("CPR")).toBe("씨피알");
  });

  it("숫자가 든 약어도 읽는다", () => {
    expect(toHangulReading("SpO2")).toBe("에스피오투");
    expect(toHangulReading("T3")).toBe("티쓰리");
  });

  it("되읽은 것을 다시 파싱하면 원래 약어가 나온다 (왕복)", () => {
    for (const row of ALL_ABBREVS) {
      const key = row.abbr.toUpperCase().replace(/[^A-Z0-9]/g, "");
      // 한 글자 약어(K 등)는 일부러 제외한다. "케이" 한 마디를 K로 되돌리면
      // 오탐이 폭발한다. 기록에서 눈으로 볼 때만 쓰는 항목이다.
      if (key.length < 2) continue;
      const reading = toHangulReading(row.abbr);
      if (!reading) continue;
      expect(expandInitialism(reading), `${row.abbr} 왕복 실패`).toContain(key);
    }
  });

  it("한 글자 약어는 발음형으로 되돌리지 않는다", () => {
    expect(expandInitialism("케이")).toEqual([]);
  });

  it("읽을 수 없는 글자가 있으면 반쪽 결과를 내지 않는다", () => {
    expect(toHangulReading("")).toBe("");
    expect(toHangulReading("한글")).toBe("");
  });
});

describe("약어 표 무결성", () => {
  it("약어가 중복되지 않는다", () => {
    const keys = ALL_ABBREVS.map((r) => r.abbr.toUpperCase().replace(/[^A-Z0-9]/g, ""));
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes, `중복 약어: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
  });

  it("모든 행에 영문과 한글이 있다", () => {
    for (const row of ALL_ABBREVS) {
      expect(row.en.length, `${row.abbr}`).toBeGreaterThan(1);
      expect(row.ko.length, `${row.abbr}`).toBeGreaterThan(0);
    }
  });

  it("중의적 약어는 두 뜻을 모두 적어 둔다", () => {
    for (const row of ALL_ABBREVS.filter((r) => r.ambiguous)) {
      expect(row.ko, `${row.abbr}`).toContain("/");
    }
  });

  it("사전이 실용적인 규모다", () => {
    // 개념 수보다 **인식 가능한 표기형 수**가 실제 적중률을 좌우한다.
    // 한 개념이 한글 표기·영문·약어·현장 변이형·오인식 표기를 함께 갖기 때문이다.
    expect(BUILTIN_TERMS.length).toBeGreaterThan(450);
    const surfaces = new Set(BUILTIN_TERMS.flatMap(surfacesOf));
    expect(surfaces.size).toBeGreaterThan(2000);
  });

  it("손으로 쓴 항목이 약어 표보다 우선한다", () => {
    // NPO 는 양쪽에 다 있다. 정의와 주의점이 충실한 쪽이 이겨야 한다.
    const hit = defaultLexicon.lookup("NPO");
    expect(hit?.entry.id).toBe("npo");
    expect(hit?.entry.pitfall).toBeTruthy();
  });
});

describe("약어를 넣으면 한국어 발음형이 공짜로 인식된다", () => {
  // 어느 표(손으로 쓴 것 / 약어 표)에서 왔는지는 상관없다.
  // 중요한 것은 "말한 그대로가 그 약어로 이어지는가" 하나다.
  it.each([
    ["에이비지에이", "ABGA"],
    ["씨알피", "CRP"],
    ["에이엠아이", "AMI"],
    ["에스피오투", "SPO2"],
    ["에이치비에이원씨", "HBA1C"],
    ["씨알알티", "CRRT"],
  ])("%s → %s", (spoken, abbr) => {
    const hit = defaultLexicon.lookup(spoken);
    expect(hit, `${spoken} 를 못 찾음`).not.toBeNull();
    expect(hit!.entry.abbr?.toUpperCase().replace(/[^A-Z0-9]/g, "")).toBe(abbr);
  });

  it("문장 안에서도 약어로 되돌린다", () => {
    const r = correctTranscript("씨알피 올랐고 더블유비씨도 높아요");
    expect(r.text).toContain("CRP");
    expect(r.termIds).toContain("abbr-crp");
  });

  it("중의적 약어는 뜻을 하나로 정하지 않고 경고를 남긴다", () => {
    // D/C 는 손으로 쓴 항목이 이긴다. 어느 쪽이 이기든 두 뜻이 다 보여야 한다.
    const dc = defaultLexicon.lookup("D/C");
    expect(dc).not.toBeNull();
    // 화면에 보이는 글 전체를 본다 — 표제어·정의·주의점 어디에 적혀 있든 상관없다.
    const text = [dc!.entry.ko, dc!.entry.definition, dc!.entry.pitfall ?? ""].join(" ");
    expect(text).toContain("퇴원");
    expect(text).toContain("중단");

    // SSI 는 약어 표 쪽. 인슐린과 수술부위감염이 둘 다 남아 있어야 한다.
    const ssi = defaultLexicon.lookup("SSI");
    expect(ssi!.entry.ko).toContain("인슐린");
    expect(ssi!.entry.ko).toContain("수술부위감염");
  });
});

describe("성능", () => {
  it("사전이 커져도 한 문장 교정이 빠르다", () => {
    const sentence =
      "엔피오 유지하고 아이오 정확히 재고 씨알피 확인한 다음 폴리 소변량 보고 노티 주세요";
    const started = Date.now();
    for (let i = 0; i < 20; i++) correctTranscript(sentence);
    const perCall = (Date.now() - started) / 20;
    // 폰에서 8시간 녹음을 처리해야 한다. 문장당 100ms를 넘으면 못 쓴다.
    expect(perCall).toBeLessThan(100);
  });
});
