/**
 * 암기 반복 — 한 묶음을 다 욀 때까지 돌린다.
 *
 * 간격 반복(srs.ts)과 다른 자리다. 그쪽은 "오늘 볼 카드"를 정하는 긴 호흡이고,
 * 여기는 앉은 자리에서 한 묶음을 끝까지 미는 짧은 호흡이다. 둘 다 쓴다 —
 * 외운 카드는 여기서 빠지고, 그 결과는 srs 에도 남아 다음 날짜가 잡힌다.
 *
 * 규칙은 넷뿐이다.
 *  · 오른쪽으로 넘기면(외웠다) 이번 회차에서 빠진다
 *  · 왼쪽으로 넘기면(더 볼래) 맨 뒤로 가서 이번 회차에 다시 나온다
 *  · 남은 것이 없으면 회차가 끝난다
 *  · 끝나면 묶음 전체로 다시 시작한다 — 외운 것도 다시 본다
 */

export interface Drill {
  /** 이번 회차에 남은 카드. 앞에서부터 꺼낸다. */
  queue: string[];
  /** 이 묶음 전체. 회차가 끝나면 여기서 다시 시작한다. */
  all: string[];
  /** 몇 회차인가. 1부터. */
  round: number;
  /** 이번 회차에 외운 장수. */
  known: number;
}

export function startDrill(ids: string[]): Drill {
  return { queue: [...ids], all: [...ids], round: 1, known: 0 };
}

/**
 * 한 장에 답한다.
 *
 * 마지막 한 장을 "더 볼래"로 넘기면 그 한 장만 도는 것이 아니라 회차를 끝낸다 —
 * 같은 카드가 혼자 무한히 되풀이되면 사람이 빠져나갈 길이 없다. 회차를 넘겨
 * 묶음 전체를 다시 보게 한다.
 */
export function answerDrill(drill: Drill, known: boolean): Drill {
  const [head, ...rest] = drill.queue;
  if (head === undefined) return drill;

  const next = known ? rest : rest.length > 0 ? [...rest, head] : [];
  const knownCount = drill.known + (known ? 1 : 0);
  if (next.length > 0) return { ...drill, queue: next, known: knownCount };

  // 회차가 끝났다. 묶음 전체로 다시.
  return { queue: [...drill.all], all: drill.all, round: drill.round + 1, known: 0 };
}

/** 이번 회차가 얼마나 남았나 (0~1). 화면의 진행 막대가 쓴다. */
export function drillProgress(drill: Drill): number {
  if (drill.all.length === 0) return 1;
  return (drill.all.length - drill.queue.length) / drill.all.length;
}
