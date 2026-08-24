/**
 * 화자 지정 — 기계가 못 하는 것을 사람이 빠르게 하도록.
 *
 * 왜 손으로 해야 하는가
 * -------------------
 * whisper.cpp 는 화자를 나누지 못한다. Whisper 는 음성을 글자로 옮기는 모델이지
 * 목소리를 구별하는 모델이 아니다. 화자분리는 화자 임베딩을 뽑아 군집화하는
 * 별개의 모델(pyannote 등)이 하는 일이고, 그건 폰에 올릴 수 있는 물건이 아니다.
 *
 * 그런데 **누가 말했는가는 이 앱에서 가장 중요한 정보다.** 태움 판정은 전부
 * 여기에 달려 있다 — 선배가 한 말인지 내가 한 말인지 환자가 한 말인지에 따라
 * 완전히 다른 이야기가 된다.
 *
 * 그래서 자동으로 못 하면 **손으로 하되 빠르게** 되어야 한다.
 *
 * 한 줄씩 누르게 하면 안 된다
 * -------------------------
 * 8시간 근무에 문장이 수백 개다. 하나씩 지정하라고 하면 아무도 안 한다.
 *
 * 대화는 **덩어리로 흐른다.** 인계는 선배가 한참 말하고 내가 한참 답하는 식이다.
 * 그래서 "여기서부터 저기까지 선배" 를 한 번에 지정하는 것이 맞는 단위다.
 * 수백 번이 대여섯 번이 된다.
 */

import type { SpeakerRole, TranscriptSegment } from "./types.js";

/**
 * 구간에 화자를 지정한다.
 *
 * `fromId` 부터 `toId` 까지(양끝 포함) 같은 역할을 준다.
 * 두 id 의 순서가 뒤집혀 있어도 알아서 바로잡는다 — 화면에서 아래를 먼저
 * 누르는 일이 실제로 자주 있다.
 *
 * 원본을 바꾸지 않고 새 배열을 돌려준다.
 */
export function assignSpeakerRange(
  segments: readonly TranscriptSegment[],
  fromId: string,
  toId: string,
  role: SpeakerRole,
): TranscriptSegment[] {
  const a = segments.findIndex((s) => s.id === fromId);
  const b = segments.findIndex((s) => s.id === toId);
  if (a < 0 || b < 0) return [...segments];

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return segments.map((s, i) => (i >= lo && i <= hi ? { ...s, speakerRole: role } : s));
}

/**
 * 여기서부터 끝까지 지정한다.
 *
 * 인계 녹음은 앞부분이 잡담이고 뒤부터 본론인 경우가 많아서,
 * "여기부터 전부" 가 실제로 제일 자주 쓰인다.
 */
export function assignSpeakerFrom(
  segments: readonly TranscriptSegment[],
  fromId: string,
  role: SpeakerRole,
): TranscriptSegment[] {
  const last = segments[segments.length - 1];
  if (!last) return [];
  return assignSpeakerRange(segments, fromId, last.id, role);
}

/**
 * 아직 지정 안 된 구간을 한 번에 채운다.
 * 대부분이 한 사람일 때(예: 내가 거의 안 말한 근무) 마무리용.
 */
export function fillUnassigned(
  segments: readonly TranscriptSegment[],
  role: SpeakerRole,
): TranscriptSegment[] {
  return segments.map((s) =>
    !s.speakerRole || s.speakerRole === "unknown" ? { ...s, speakerRole: role } : s,
  );
}

export interface SpeakerCoverage {
  total: number;
  labeled: number;
  /** 0~1. */
  ratio: number;
  /** 본인 발화가 하나라도 지정되었는가. */
  hasSelf: boolean;
  /**
   * 태움 점수를 낼 수 있는 상태인가.
   *
   * 본인 발화가 하나도 지정되지 않았으면 낼 수 없다. 그 상태에서 점수를 내면
   * **내가 한 말이 남이 한 말로 세어진다.** 0점이 나오는 것보다 나쁘다.
   */
  readyForScoring: boolean;
  /** 사람에게 보여줄 한 줄. */
  message: string;
}

export function speakerCoverage(
  segments: readonly TranscriptSegment[],
): SpeakerCoverage {
  const total = segments.length;
  const labeled = segments.filter(
    (s) => s.speakerRole && s.speakerRole !== "unknown",
  ).length;
  const hasSelf = segments.some((s) => s.speakerRole === "self");
  const ratio = total > 0 ? labeled / total : 0;

  let message: string;
  if (total === 0) {
    message = "전사된 문장이 없습니다.";
  } else if (labeled === 0) {
    message =
      "아직 아무도 지정하지 않았습니다. 누가 말했는지 모르면 근무 환경 지표를 낼 수 없습니다.";
  } else if (!hasSelf) {
    message =
      "본인 발화가 하나도 지정되지 않았습니다. 이대로 두면 본인이 한 말이 남이 한 말로 세어집니다.";
  } else if (labeled < total) {
    message = `${total}개 중 ${labeled}개 지정했습니다. 지정 안 된 문장은 지표에서 빠집니다.`;
  } else {
    message = "모두 지정했습니다.";
  }

  return {
    total,
    labeled,
    ratio,
    hasSelf,
    readyForScoring: hasSelf,
    message,
  };
}

/**
 * 연속으로 같은 역할인 구간들.
 * 화면에서 "선배가 말한 구간 3개" 처럼 접어 보여줄 때 쓴다.
 */
export interface SpeakerRun {
  role: SpeakerRole;
  startIndex: number;
  endIndex: number;
  startSec: number;
  endSec: number;
  count: number;
}

export function speakerRuns(
  segments: readonly TranscriptSegment[],
): SpeakerRun[] {
  const runs: SpeakerRun[] = [];
  for (const [i, seg] of segments.entries()) {
    const role = seg.speakerRole ?? "unknown";
    const prev = runs[runs.length - 1];
    if (prev && prev.role === role) {
      prev.endIndex = i;
      prev.endSec = seg.endSec;
      prev.count += 1;
    } else {
      runs.push({
        role,
        startIndex: i,
        endIndex: i,
        startSec: seg.startSec,
        endSec: seg.endSec,
        count: 1,
      });
    }
  }
  return runs;
}
