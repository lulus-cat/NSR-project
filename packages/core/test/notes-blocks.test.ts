/**
 * 노트를 블록으로 쪼개는 규칙.
 *
 * 이 로직이 틀리면 **사용자 글이 사라진다** — 편집기가 블록 단위로 고치고
 * 다시 붙이기 때문이다. 그래서 제일 중요한 시험은 "쪼갰다 붙이면 그대로인가"다.
 */
import { describe, expect, it } from "vitest";
import { joinBlocks, parseTable, splitBlocks } from "../src/notes/blocks.js";
import { reportWithoutCards } from "../src/study/report-cards.js";

const 예시보고서 = [
  "# 2026-09-06 데이 근무",
  "",
  "## 타임라인",
  "| 시각 | 국면 | 무엇이 있었나 |",
  "| --- | --- | --- |",
  "| 06:50 | 환자 파악 | 전산으로 6명 훑음 |",
  "",
  "## 인계장",
  "### 환자A",
  "- 이어지는 것: 이리게이션 어제 시작",
  "- 오늘 확인: 아침 소변량",
  "",
  "> [!주의] 소변주머니는 방광보다 낮게",
  "> 거꾸로 흐르면 요로감염이 온다",
  "",
  "```",
  "set_taeum(shift_id, score=42)",
  "```",
  "",
  "---",
  "",
  "#### 카드를 많이 뽑는다",
  "본문 한 줄.",
  "이어지는 본문 한 줄.",
].join("\n");

describe("splitBlocks / joinBlocks", () => {
  it("쪼갰다 붙이면 원본과 한 글자도 다르지 않다", () => {
    for (const 원본 of [
      예시보고서,
      "",
      "\n",
      "한 줄",
      "한 줄\n",
      "\n\n\n",
      "- 목록\n- 목록\n",
      "| a | b |\n| --- | --- |\n",
      "```\n안 닫힌 코드",
      "끝에 빈 줄 둘\n\n",
    ]) {
      expect(joinBlocks(splitBlocks(원본))).toBe(원본);
    }
  });

  it("갈래를 알아본다", () => {
    const kinds = splitBlocks(예시보고서).map((b) => b.kind);
    expect(kinds[0]).toBe("heading");
    expect(kinds).toContain("table");
    expect(kinds).toContain("list");
    expect(kinds).toContain("quote");
    expect(kinds).toContain("code");
    expect(kinds).toContain("rule");
    expect(kinds).toContain("para");
  });

  it("표는 여러 줄이 한 블록이다", () => {
    const table = splitBlocks(예시보고서).find((b) => b.kind === "table");
    expect(table?.text.split("\n")).toHaveLength(3);
  });

  it("목록은 한 줄이 한 블록이다 — 한 항목만 고치게", () => {
    const items = splitBlocks("- 하나\n- 둘\n- 셋").filter((b) => b.kind === "list");
    expect(items).toHaveLength(3);
  });

  it("코드 울타리 안의 #제목·|표 는 코드로 둔다", () => {
    const blocks = splitBlocks("```\n# 제목 아님\n| 표 | 아님 |\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("code");
  });

  it("안 닫힌 코드 울타리는 끝까지 코드다 — 글자를 잃지 않는다", () => {
    const blocks = splitBlocks("```\n한 줄\n또 한 줄");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("```\n한 줄\n또 한 줄");
  });

  it("제목은 여섯 단계까지", () => {
    expect(splitBlocks("###### 여섯")[0].kind).toBe("heading");
    expect(splitBlocks("####### 일곱")[0].kind).toBe("para");
    expect(splitBlocks("#태그만 있는 줄")[0].kind).toBe("para");
  });

  it("잇단 본문 줄은 한 블록으로 묶는다", () => {
    const blocks = splitBlocks("한 줄\n두 줄\n\n세 줄");
    expect(blocks.map((b) => b.kind)).toEqual(["para", "blank", "para"]);
    expect(blocks[0].text).toBe("한 줄\n두 줄");
  });
});

describe("parseTable", () => {
  it("머리와 몸을 가른다", () => {
    const t = parseTable("| 시각 | 국면 |\n| --- | --- |\n| 06:50 | 환자 파악 |");
    expect(t?.header).toEqual(["시각", "국면"]);
    expect(t?.rows).toEqual([["06:50", "환자 파악"]]);
  });

  it("칸 수가 모자라면 빈 칸으로 채운다 — 줄이 깨져도 표로 보인다", () => {
    const t = parseTable("| a | b | c |\n| --- | --- | --- |\n| 하나 |");
    expect(t?.rows).toEqual([["하나", "", ""]]);
  });

  it("구분선이 없으면 표가 아니다", () => {
    expect(parseTable("| a | b |\n| 하나 | 둘 |")).toBeNull();
  });

  it("몸이 없어도 머리만으로 표다", () => {
    expect(parseTable("| a | b |\n| --- | --- |")?.rows).toEqual([]);
  });
});

describe("reportWithoutCards", () => {
  it("`## 카드` 절만 걷어낸다", () => {
    const md = [
      "# 근무",
      "## 타임라인",
      "본문",
      "## 카드",
      "Q: 물음",
      "A: 답",
      "## 복습",
      "- 하나",
    ].join("\n");
    const out = reportWithoutCards(md);
    expect(out).not.toContain("Q: 물음");
    expect(out).not.toContain("## 카드");
    expect(out).toContain("## 타임라인");
    expect(out).toContain("## 복습");
    expect(out).toContain("- 하나");
  });

  it("`## 사건 카드` 는 건드리지 않는다 — 카드 절이 아니다", () => {
    const md = "## 사건 카드\n- 있었던 일\n";
    expect(reportWithoutCards(md)).toContain("사건 카드");
  });

  it("카드 절이 맨 끝이어도 된다", () => {
    expect(reportWithoutCards("## 복습\n- 하나\n## 카드\nQ: 물음\nA: 답")).not.toContain("Q:");
  });

  it("카드 절이 없으면 그대로 둔다", () => {
    const md = "# 근무\n## 타임라인\n본문";
    expect(reportWithoutCards(md)).toBe(md);
  });
});
