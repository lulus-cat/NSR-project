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
  /**
   * 이번 회차에 한 번이라도 본 카드. '처음 보는 카드가 몇 장 남았나' 가 여기서 나온다.
   *
   * 외운 장수만으로는 회차의 어디쯤인지 모른다 — '더 볼래' 를 누를 때마다 막대가
   * 제자리라, 스무 장 중 열다섯 장을 넘겨도 처음과 똑같아 보였다.
   */
  seen: string[];
}

export function startDrill(ids: string[]): Drill {
  return { queue: [...ids], all: [...ids], round: 1, known: 0, seen: [] };
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
  const seen = drill.seen.includes(head) ? drill.seen : [...drill.seen, head];
  if (next.length > 0) return { ...drill, queue: next, known: knownCount, seen };

  // 회차가 끝났다. 묶음 전체로 다시.
  return { queue: [...drill.all], all: drill.all, round: drill.round + 1, known: 0, seen: [] };
}

/** 이번 회차에 아직 한 번도 안 본 카드 수. */
export function drillUnseen(drill: Drill): number {
  const seen = new Set(drill.seen);
  return drill.all.filter((id) => !seen.has(id)).length;
}

/**
 * 저장해 둔 자리에서 이어 간다.
 *
 * 화면에만 들고 있으면 다른 화면으로 갔다 오거나 앱이 죽었다 살아날 때마다 처음부터였다.
 * 그사이 카드가 바뀌었을 수 있다 — AI 가 보고서를 다시 써서 카드가 새로 오거나 지워진다.
 * 지워진 카드는 빼고, 새 카드는 이번 회차 줄 끝에 넣는다. 남은 카드가 다 지워졌으면
 * 그 회차는 끝난 것이라 다음 회차로 넘긴다.
 */
export function resumeDrill(saved: Drill | null, ids: string[]): Drill {
  if (!saved || !Array.isArray(saved.all) || !Array.isArray(saved.queue)) return startDrill(ids);
  const live = new Set(ids);
  const before = new Set(saved.all);
  const added = ids.filter((id) => !before.has(id));
  const all = [...saved.all.filter((id) => live.has(id)), ...added];
  const queue = [...saved.queue.filter((id) => live.has(id)), ...added];
  if (all.length === 0) return startDrill(ids);
  if (queue.length === 0) return { ...startDrill(all), round: saved.round + 1 };
  return {
    queue,
    all,
    round: saved.round,
    known: saved.known,
    seen: (saved.seen ?? []).filter((id) => live.has(id)),
  };
}

/** 이번 회차가 얼마나 남았나 (0~1). 화면의 진행 막대가 쓴다. */
export function drillProgress(drill: Drill): number {
  if (drill.all.length === 0) return 1;
  return (drill.all.length - drill.queue.length) / drill.all.length;
}
