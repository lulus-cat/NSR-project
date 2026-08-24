import { describe, it, expect } from "vitest";
import {
  addTermToPack,
  buildLexicon,
  createWardPack,
  defaultLexicon,
  draftTermFromSuggestion,
  exportWardPack,
  importWardPack,
  mergeWardPacks,
  packStats,
  removeTermFromPack,
  suggestPackTerms,
  WARD_PACK_SCHEMA_VERSION,
  type LexiconEntry,
  type WardPack,
} from "../src/lexicon/index.js";
import { correctTranscript } from "../src/transcription/index.js";

const NOW = 1_756_000_000_000;

function term(id: string, ko: string, aliases: string[] = []): LexiconEntry {
  return { id, ko, aliases, category: "workflow", definition: `${ko}를 가리키는 우리 병동 말.` };
}

function samplePack(): WardPack {
  return createWardPack({
    id: "ward-71",
    name: "○○병원 71병동",
    hospital: "○○병원",
    ward: "71병동",
    author: "선배",
    now: NOW,
    terms: [
      term("ward-71-yakjang", "약장", ["약장", "약창고", "약장열쇠"]),
      term("ward-71-dwitbang", "뒷방", ["뒷방", "뒤쪽 처치실"]),
    ],
  });
}

describe("병동 사전 만들기", () => {
  it("용어를 넣고 뺀다", () => {
    let pack = createWardPack({ id: "p", name: "테스트", now: NOW });
    expect(pack.terms).toHaveLength(0);
    pack = addTermToPack(pack, term("p-a", "가나다"), NOW + 1);
    expect(pack.terms).toHaveLength(1);
    expect(pack.updatedAt).toBe(NOW + 1);
    pack = removeTermFromPack(pack, "p-a", NOW + 2);
    expect(pack.terms).toHaveLength(0);
  });

  it("같은 id를 넣으면 갈아 끼운다", () => {
    let pack = createWardPack({ id: "p", name: "테스트", now: NOW });
    pack = addTermToPack(pack, term("p-a", "예전 말"), NOW);
    pack = addTermToPack(pack, term("p-a", "고친 말"), NOW);
    expect(pack.terms).toHaveLength(1);
    expect(pack.terms[0].ko).toBe("고친 말");
  });

  it("통계를 낸다", () => {
    const stats = packStats(samplePack());
    expect(stats.terms).toBe(2);
    expect(stats.surfaces).toBeGreaterThanOrEqual(4);
  });
});

describe("내보내기 / 가져오기", () => {
  it("내보낸 것을 그대로 다시 읽는다 (왕복)", () => {
    const pack = samplePack();
    const result = importWardPack(exportWardPack(pack));
    expect(result.errors).toEqual([]);
    expect(result.pack?.id).toBe(pack.id);
    expect(result.pack?.name).toBe(pack.name);
    expect(result.pack?.terms).toHaveLength(2);
  });

  it("같은 내용이면 같은 글자가 나온다", () => {
    const a = samplePack();
    const b = { ...samplePack(), terms: [...samplePack().terms].reverse() };
    expect(exportWardPack(a)).toBe(exportWardPack(b));
  });

  it("JSON이 아니면 사유를 알려준다", () => {
    const r = importWardPack("이건 사전이 아닙니다");
    expect(r.pack).toBeNull();
    expect(r.errors[0]).toContain("JSON");
  });

  it("사전 형태가 아니면 거절한다", () => {
    expect(importWardPack("[1,2,3]").pack).toBeNull();
    expect(importWardPack('"문자열"').pack).toBeNull();
    expect(importWardPack("null").pack).toBeNull();
  });

  it("더 새로운 형식이면 앱을 올리라고 한다", () => {
    const r = importWardPack(
      JSON.stringify({ schemaVersion: WARD_PACK_SCHEMA_VERSION + 1, id: "x", name: "미래", terms: [] }),
    );
    expect(r.pack).toBeNull();
    expect(r.errors[0]).toContain("업데이트");
  });

  it("항목 하나가 잘못됐다고 사전 전체를 버리지 않는다", () => {
    const r = importWardPack(
      JSON.stringify({
        schemaVersion: 1,
        id: "p",
        name: "섞인 사전",
        terms: [
          { id: "ok", ko: "정상", aliases: [], category: "workflow", definition: "괜찮은 항목." },
          { id: "no-ko", aliases: [], category: "workflow", definition: "표기가 없다." },
          { ko: "id 없음", aliases: [], category: "workflow", definition: "id가 없다." },
          "문자열",
          null,
        ],
      }),
    );
    expect(r.pack?.terms).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("모르는 분류는 안전한 기본값으로 떨어뜨린다", () => {
    const r = importWardPack(
      JSON.stringify({
        schemaVersion: 1,
        id: "p",
        name: "p",
        terms: [{ id: "a", ko: "가", aliases: [], category: "해킹", definition: "설명." }],
      }),
    );
    expect(r.pack?.terms[0].category).toBe("workflow");
  });

  it("지나치게 큰 사전은 잘라서 가져온다", () => {
    const terms = Array.from({ length: 6000 }, (_, i) => ({
      id: `t${i}`, ko: `말${i}`, aliases: [], category: "workflow", definition: "설명.",
    }));
    const r = importWardPack(JSON.stringify({ schemaVersion: 1, id: "p", name: "큰 사전", terms }));
    expect(r.pack!.terms.length).toBe(5000);
    expect(r.warnings.some((w) => w.includes("너무 많아"))).toBe(true);
  });

  it("중복 id는 하나만 남긴다", () => {
    const r = importWardPack(
      JSON.stringify({
        schemaVersion: 1, id: "p", name: "p",
        terms: [
          { id: "a", ko: "첫번째", aliases: [], category: "workflow", definition: "설명." },
          { id: "a", ko: "두번째", aliases: [], category: "workflow", definition: "설명." },
        ],
      }),
    );
    expect(r.pack?.terms).toHaveLength(1);
    expect(r.pack?.terms[0].ko).toBe("첫번째");
  });

  it("글자 치환 규칙은 자동으로 켜지지 않는다", () => {
    const r = importWardPack(
      JSON.stringify({
        schemaVersion: 1, id: "p", name: "p", terms: [],
        corrections: [{ from: "십 밀리그램", to: "백 밀리그램", count: 9 }],
      }),
    );
    // 사전에는 안 실린다.
    expect(r.pack?.corrections).toBeUndefined();
    // 확인 대기 목록으로만 온다.
    expect(r.pendingCorrections).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("자동으로 켜지지 않"))).toBe(true);
  });
});

describe("세 층 우선순위", () => {
  const pack = createWardPack({
    id: "w", name: "우리 병동", now: NOW,
    // 내장 사전의 '석션'을 병동 사전이 덮어쓴다.
    terms: [{ id: "suction", ko: "병동식 석션", aliases: ["우리석션"], category: "procedure", definition: "우리 병동 정의." }],
  });

  it("병동 사전이 내장 사전을 덮는다", () => {
    const lex = buildLexicon({ packs: [pack] });
    expect(lex.get("suction")?.ko).toBe("병동식 석션");
    expect(lex.lookup("우리석션")?.entry.id).toBe("suction");
  });

  it("내 사전이 병동 사전을 덮는다", () => {
    const lex = buildLexicon({
      userTerms: [{ id: "suction", ko: "내가 고친 석션", aliases: [], category: "procedure", definition: "내 정의." }],
      packs: [pack],
    });
    expect(lex.get("suction")?.ko).toBe("내가 고친 석션");
  });

  it("뒤에 온 병동 사전이 앞을 덮는다", () => {
    const older = createWardPack({ id: "a", name: "a", now: NOW, terms: [term("x", "예전")] });
    const newer = createWardPack({ id: "b", name: "b", now: NOW, terms: [term("x", "최신")] });
    expect(mergeWardPacks([older, newer])[0].ko).toBe("최신");
  });

  it("병동 사전에만 있는 말도 전사에서 인식된다", () => {
    const wardPack = createWardPack({
      id: "w2", name: "w2", now: NOW,
      terms: [{
        id: "w2-yakjang", ko: "약장", aliases: ["약장", "약창고"],
        category: "workflow", definition: "병동 약을 두는 곳.",
      }],
    });
    const lex = buildLexicon({ packs: [wardPack] });
    const r = correctTranscript("약장 열쇠 어디 있어요", { lexicon: lex });
    expect(r.termIds).toContain("w2-yakjang");
    // 내장 사전만 쓰면 못 찾는다.
    expect(correctTranscript("약장 열쇠 어디 있어요").termIds).not.toContain("w2-yakjang");
  });

  it("병동 사전이 없으면 예전처럼 동작한다", () => {
    expect(buildLexicon().entries.length).toBe(defaultLexicon.entries.length);
    expect(buildLexicon([]).entries.length).toBe(defaultLexicon.entries.length);
  });
});

describe("교정 이력에서 병동 용어 제안", () => {
  const isKnown = (s: string) => defaultLexicon.lookup(s) !== null;

  it("사전에 없는 말로 반복해서 고쳤으면 후보로 올린다", () => {
    const s = suggestPackTerms(
      [{ from: "약짱", to: "약장", count: 4 }],
      isKnown,
    );
    expect(s).toHaveLength(1);
    expect(s[0].surface).toBe("약장");
    expect(s[0].reason).toBe("unknown-term");
  });

  it("사전에 이미 있는 말로 고친 것은 후보가 아니다", () => {
    // '석션'은 내장 사전에 있다. 그건 그냥 오인식 교정이지 새 용어가 아니다.
    expect(suggestPackTerms([{ from: "쎅션", to: "석션", count: 9 }], isKnown)).toHaveLength(0);
  });

  it("한 번만 고친 것은 후보가 아니다", () => {
    expect(suggestPackTerms([{ from: "가", to: "듣도보도못한말", count: 1 }], isKnown)).toHaveLength(0);
  });

  it("자주 고친 것부터 보여준다", () => {
    const s = suggestPackTerms(
      [
        { from: "a", to: "처음보는말하나", count: 2 },
        { from: "b", to: "처음보는말둘", count: 7 },
      ],
      isKnown,
    );
    expect(s[0].surface).toBe("처음보는말둘");
  });

  it("제안을 용어 초안으로 만든다", () => {
    const draft = draftTermFromSuggestion(
      { surface: "약장", count: 3, reason: "unknown-term" },
      "ward-71",
      "병동 약을 두는 곳.",
    );
    expect(draft.id).toBe("ward-71-약장");
    expect(draft.ko).toBe("약장");
    expect(draft.informal).toBe(true);
  });
});
