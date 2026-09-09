/**
 * 달력 한 판의 칸 목록.
 *
 * 앞은 첫날의 요일만큼 비우고, 뒤는 일곱의 배수가 되도록 채운다. 빈 칸은 null.
 * 날짜 문자열로 주는 이유는 화면이 Date 를 다시 만들지 않게 하기 위해서다 —
 * `new Date(문자열)` 은 시간대에 따라 하루가 밀린다.
 */
import { toDateString } from "./schedule.js";

export function monthCells(year: number, month: number): (string | null)[] {
  const firstDow = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: days }, (_, i) => toDateString(new Date(year, month, i + 1).getTime())),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
