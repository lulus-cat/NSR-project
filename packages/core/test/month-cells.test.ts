/**
 * 달력 한 판을 만드는 계산.
 *
 * 날짜 계산은 조용히 틀린다 — 한 칸 밀리면 사용자가 엉뚱한 날에 근무를 넣고,
 * 그 근무는 다시 못 찾는다. 그래서 화면이 아니라 여기서 시험한다.
 */
import { describe, expect, it } from "vitest";
import { monthCells } from "../src/duty/month.js";

describe("monthCells", () => {
  it("첫날의 요일만큼 앞을 비운다", () => {
    // 2026-09-01 은 화요일 → 일·월 두 칸이 빈다
    const cells = monthCells(2026, 8);
    expect(cells.slice(0, 2)).toEqual([null, null]);
    expect(cells[2]).toBe("2026-09-01");
  });

  it("일곱의 배수로 끝난다", () => {
    for (let m = 0; m < 12; m++) expect(monthCells(2026, m).length % 7).toBe(0);
  });

  it("그 달의 날을 하나도 빠뜨리지 않는다", () => {
    const days = monthCells(2026, 1).filter(Boolean); // 2월
    expect(days).toHaveLength(28);
    expect(days[0]).toBe("2026-02-01");
    expect(days.at(-1)).toBe("2026-02-28");
  });

  it("윤년 2월 29일이 있다", () => {
    expect(monthCells(2028, 1).filter(Boolean)).toHaveLength(29);
  });

  it("달을 넘겨도 어긋나지 않는다 — 12월 다음은 이듬해 1월", () => {
    expect(monthCells(2026, 11).filter(Boolean).at(-1)).toBe("2026-12-31");
    expect(monthCells(2027, 0).filter(Boolean)?.[0]).toBe("2027-01-01");
  });

  it("한 해 열두 달의 날 수를 모두 센다", () => {
    const n = Array.from({ length: 12 }, (_, m) => monthCells(2026, m).filter(Boolean).length);
    expect(n).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    expect(n.reduce((a, b) => a + b, 0)).toBe(365);
  });
});
