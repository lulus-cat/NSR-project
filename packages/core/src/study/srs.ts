/**
 * 간격 반복(spaced repetition) 스케줄러 — SM-2 기반.
 *
 * SM-2를 쓰는 이유는 단순해서다. 파라미터가 세 개(반복 횟수, 간격, 용이도)뿐이고
 * 오프라인 기기 안에서 계산이 끝나며, 동작을 사람이 예측할 수 있다.
 * (전사·요약과 달리 여기엔 서버가 필요 없다.)
 *
 * 교대근무에 맞춘 변형
 * -------------------
 * 표준 SM-2는 "매일 비슷한 시간에 공부한다"를 가정한다. 3교대는 그 가정이 깨진다.
 * 나이트 근무일에 복습이 걸리면 그 카드는 그냥 밀린다. 밀린 카드가 쌓이면
 * 앱을 안 열게 되고, 그러면 전체가 무너진다.
 *
 * 그래서 `shiftDueDateOffDuty`로 복습 예정일을 근무 상황에 맞게 당기거나 미룬다.
 * 나이트/연속근무일에 걸린 복습은 가장 가까운 오프로 옮긴다.
 */

export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

export interface ReviewState {
  cardId: string;
  /** 연속으로 성공(3점 이상)한 횟수. 실패하면 0으로 돌아간다. */
  repetitions: number;
  /** 다음 복습까지의 간격(일). */
  intervalDays: number;
  /** 용이도 계수. 낮을수록 자주 나온다. 최소 1.3. */
  easeFactor: number;
  /** 다음 복습 예정 시각 (epoch ms). */
  dueAt: number;
  /** 성공했다가 다시 실패한 횟수. 높으면 카드 자체를 다시 만들어야 한다는 신호. */
  lapses: number;
  lastReviewedAt?: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EASE = 1.3;
const INITIAL_EASE = 2.5;

export function newCardState(cardId: string, now: number): ReviewState {
  return {
    cardId,
    repetitions: 0,
    intervalDays: 0,
    easeFactor: INITIAL_EASE,
    dueAt: now,
    lapses: 0,
  };
}

/**
 * 한 번의 복습 결과를 반영한다.
 *
 * @param grade 0~5. 3 미만은 실패로 본다.
 *   0 전혀 기억 안 남 / 1 틀렸지만 답 보니 기억남 / 2 틀렸지만 쉬웠음
 *   3 맞았지만 힘들었음 / 4 맞았음 / 5 쉽게 맞았음
 */
export function review(state: ReviewState, grade: Grade, now: number): ReviewState {
  // 용이도 갱신은 성공/실패 모두에 적용된다 (SM-2 원식).
  const ease = Math.max(
    MIN_EASE,
    state.easeFactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)),
  );

  if (grade < 3) {
    return {
      ...state,
      repetitions: 0,
      intervalDays: 1,
      easeFactor: ease,
      // 실패한 카드는 다음 날 다시. 같은 세션 안에서 반복시키지 않는다.
      dueAt: now + DAY_MS,
      lapses: state.lapses + 1,
      lastReviewedAt: now,
    };
  }

  const repetitions = state.repetitions + 1;
  let intervalDays: number;
  if (repetitions === 1) intervalDays = 1;
  else if (repetitions === 2) intervalDays = 6;
  else intervalDays = Math.round(state.intervalDays * ease);
  // 과도한 간격 방지. 1년 넘게 안 보면 사실상 잊는다.
  intervalDays = Math.min(intervalDays, 365);

  return {
    ...state,
    repetitions,
    intervalDays,
    easeFactor: ease,
    dueAt: now + intervalDays * DAY_MS,
    lastReviewedAt: now,
  };
}

/**
 * 지금 풀어야 할 카드.
 * 밀린 카드가 많으면 오래된 것부터, 그다음 용이도가 낮은(=어려운) 것부터 낸다.
 */
export function dueStates(
  states: readonly ReviewState[],
  now: number,
  limit = 20,
): ReviewState[] {
  return states
    .filter((s) => s.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt || a.easeFactor - b.easeFactor)
    .slice(0, limit);
}

export interface StudyStats {
  total: number;
  due: number;
  /** 아직 한 번도 성공하지 못한 카드. */
  learning: number;
  /** 간격이 21일 이상인 카드. 사실상 장기기억으로 넘어간 것으로 본다. */
  mature: number;
  /** 반복 실패 카드. 카드 자체가 나쁘거나 선행 지식이 없다는 신호. */
  leeches: number;
}

export function studyStats(
  states: readonly ReviewState[],
  now: number,
  leechThreshold = 4,
): StudyStats {
  let due = 0;
  let learning = 0;
  let mature = 0;
  let leeches = 0;
  for (const s of states) {
    if (s.dueAt <= now) due++;
    if (s.repetitions === 0) learning++;
    if (s.intervalDays >= 21) mature++;
    if (s.lapses >= leechThreshold) leeches++;
  }
  return { total: states.length, due, learning, mature, leeches };
}

/**
 * 복습 예정일을 공부 가능한 날로 옮긴다.
 *
 * @param canStudyOn 해당 날짜(자정 기준 epoch ms)에 공부할 여력이 있는가.
 *                   보통 "나이트 근무일이 아님"으로 구현한다.
 * @param maxShiftDays 최대 며칠까지 미룰 것인가. 이 안에 못 찾으면 원래 날짜를 유지한다.
 */
export function shiftDueDateOffDuty(
  dueAt: number,
  canStudyOn: (dayStart: number) => boolean,
  maxShiftDays = 3,
): number {
  const dayStart = startOfDay(dueAt);
  if (canStudyOn(dayStart)) return dueAt;
  const timeOfDay = dueAt - dayStart;
  for (let d = 1; d <= maxShiftDays; d++) {
    const candidate = dayStart + d * DAY_MS;
    if (canStudyOn(candidate)) return candidate + timeOfDay;
  }
  return dueAt;
}

function startOfDay(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
