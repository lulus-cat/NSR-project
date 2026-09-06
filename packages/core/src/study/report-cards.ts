/**
 * 보고서 마크다운에서 카드를 뽑아낸다.
 *
 * 대화 AI 가 근무 보고서를 쓸 때 `## 카드` 절에 Q/A 를 적는다(docs/ai-instruction.md).
 * 그 글은 폰이 받아 화면에 보여 주기는 했지만 **학습 카드로는 들어가지 않았다** —
 * AI 가 카드 15장을 만들었다고 말해도 복습 탭에는 한 장도 없었다.
 *
 * 서버에 도구를 하나 더 두는 대신 보고서에서 뽑는다. AI 는 이미 그 자리에 쓰고
 * 있고, 사람이 보고서를 읽으며 확인한 그 문장이 그대로 카드가 된다.
 */
import type { Card } from "./cards.js";

/** 여러 줄에 걸쳐 이어지는 답도 받는다. 다음 Q 나 다음 절에서 끊는다. */
const Q = /^\s*(?:[-*]\s*)?Q\s*[:.]\s*(.+)$/i;
const A = /^\s*(?:[-*]\s*)?A\s*[:.]\s*(.+)$/i;
const HEADING = /^#{1,6}\s/;

/** `## 카드` 절만 잘라낸다. 다른 절의 Q/A 를 카드로 만들지 않는다. */
function cardSection(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*카드\s*$/.test(l.trim()));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => HEADING.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * 보고서에서 카드를 만든다. 같은 근무를 다시 받아도 id 가 같아서 겹치지 않는다.
 *
 * 앞면이 없거나 뒷면이 없는 쌍은 버린다 — 반쪽 카드는 복습에서 답을 못 맞힌다.
 */
export function cardsFromReport(
  shiftId: string,
  markdown: string,
  now: number = Date.now(),
): Card[] {
  const cards: Card[] = [];
  let front: string | null = null;
  let back: string[] = [];

  const flush = () => {
    const b = back.join(" ").trim();
    if (front && b) {
      cards.push({
        // 근무와 차례로 id 를 만든다. 같은 보고서를 두 번 받아도 한 장이다.
        id: `rep-${shiftId}-${cards.length + 1}`,
        kind: "formal",
        front: front.trim(),
        back: b,
        // 사전 낱말에서 나온 카드가 아니다. 되짚을 자리는 근무다.
        entryId: `report:${shiftId}`,
        shiftId,
        sourceIds: [],
        createdAt: now,
      });
    }
    front = null;
    back = [];
  };

  for (const line of cardSection(markdown)) {
    const q = line.match(Q);
    if (q) {
      flush();
      front = q[1];
      continue;
    }
    const a = line.match(A);
    if (a) {
      back = [a[1]];
      continue;
    }
    // 답이 여러 줄이면 이어 붙인다. 앞면 앞의 빈 줄과 잡글은 버린다.
    if (back.length > 0 && line.trim()) back.push(line.trim());
    else if (!line.trim()) {
      if (back.length > 0) flush();
    }
  }
  flush();
  return cards;
}
