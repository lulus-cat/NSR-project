/**
 * "지금 기록을 켤 것인가 끌 것인가" — 판단만 모아 둔 곳.
 *
 * 왜 여기 있나
 * -----------
 * 이 판단이 앱(`scheduler.ts`·`geofence.ts`)에 흩어져 있을 때 네 가지가 한꺼번에
 * 났다. 위치 판정이 **홈 버튼으로 켠 기록까지** 껐고, 사용자가 일부러 끈 기록을
 * 15분 뒤에 다시 켰고, 수동 시작이 한 번 실패하면 자동 기록이 영영 안 켜졌다.
 * 셋 다 공통점이 하나다 — **누가 켠 기록인지를 아무도 안 적어 두었다.**
 *
 * 앱에는 시험이 없다(폰이 있어야 돈다). 그래서 판단만 떼어 여기 두고 시험을
 * 붙인다. 마이크를 잡는 일은 앱이 하고, 언제 잡을지는 여기가 정한다.
 */

/** 이 기록을 켠 주체. 끄는 권한이 여기서 갈린다. */
export type RecordingOwner = "tick" | "user" | "geofence";

export interface SessionState {
  owner: RecordingOwner;
  shiftId: string;
  /** 시작 시각(epoch ms). 수동·지오펜스의 12시간 상한에 쓴다. */
  startedAt: number;
  /** 마이크가 실제로 잡혀 있는가. 조각 열기에 실패하면 거짓이 된다. */
  alive: boolean;
}

export type RecordingAction =
  | { do: "none" }
  | { do: "start"; shiftId: string; owner: RecordingOwner }
  | { do: "stop" }
  /** 세션은 남아 있는데 마이크가 죽었다. 껐다가 같은 근무로 다시 켠다. */
  | { do: "revive"; shiftId: string; owner: RecordingOwner };

/** 수동·지오펜스 기록의 상한. 끄는 것을 잊고 잠들면 폰이 하루 종일 듣는다. */
export const MANUAL_MAX_MS = 12 * 3600_000;

/**
 * 듀티표 판정(tick)이 할 일.
 *
 * 규칙 하나로 요약된다 — **tick 은 tick 이 켠 것만 끈다.** 홈 버튼과 지오펜스로
 * 켠 기록은 근무 시각 밖이어도 살려 둔다 (출근 40분 전 도착이 그렇다).
 */
export function tickDecision(input: {
  session: SessionState | null;
  /** 지금 활성인 듀티 기록 구간의 근무 id. 없으면 null. */
  windowShiftId: string | null;
  now: number;
}): RecordingAction {
  const { session, windowShiftId, now } = input;

  // 마이크가 죽은 세션은 누가 켰든 되살린다. 화면이 '기록 중'인 채로 두면
  // 사용자는 근무가 끝난 뒤에야 빈 것을 안다.
  if (session && !session.alive) {
    return { do: "revive", shiftId: session.shiftId, owner: session.owner };
  }

  if (session && session.owner !== "tick") {
    return now - session.startedAt > MANUAL_MAX_MS ? { do: "stop" } : { do: "none" };
  }

  if (windowShiftId) {
    if (!session) return { do: "start", shiftId: windowShiftId, owner: "tick" };
    return session.shiftId === windowShiftId
      ? { do: "none" }
      : { do: "start", shiftId: windowShiftId, owner: "tick" };
  }

  return session ? { do: "stop" } : { do: "none" };
}

/**
 * 위치 판정이 할 일.
 *
 * 지오펜스 신호(진입·이탈)를 놓쳤을 때의 안전망이자, 기록 중 5분마다 도는 감시다.
 * 두 가지를 지킨다.
 *   - **남의 기록은 안 건드린다.** 홈 버튼으로 켠 기록은 병원 밖에서도 계속된다.
 *   - **사람이 끈 것은 다시 안 켠다.** 자리를 비우고 싶어 끈 것을 15분 뒤에
 *     되살리면 그건 고장이 아니라 사고다. 한 번 밖으로 나갔다 와야 풀린다.
 */
export function geoDecision(input: {
  session: SessionState | null;
  /** 반경 안인가 (켤 때 쓰는 좁은 기준). */
  inside: boolean;
  /** 확실히 벗어났는가 (끌 때 쓰는 넉넉한 기준). */
  left: boolean;
  /** 오늘(또는 자정을 넘긴 어제 나이트) 근무가 있는가. */
  working: boolean;
  /** 사용자가 이 근무지 안에서 직접 끈 시각. 없으면 0. */
  stoppedByUserAt: number;
  shiftId: string;
}): RecordingAction {
  const { session, inside, left, working, stoppedByUserAt, shiftId } = input;

  if (session && session.owner === "user") return { do: "none" };

  if (left) {
    // 지오펜스가 켠 것만 끈다. tick 이 켠 근무 기록은 듀티표가 관리한다.
    return session && session.owner === "geofence" ? { do: "stop" } : { do: "none" };
  }

  if (inside && !session && working && stoppedByUserAt === 0) {
    return { do: "start", shiftId, owner: "geofence" };
  }

  return { do: "none" };
}
