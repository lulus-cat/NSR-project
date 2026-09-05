/**
 * 티로 노트의 문단을 전사 조각으로.
 *
 * 티로 앱으로 녹음한 노트는 '문단'(paragraph) 단위로 온다 — 한 화자의 말차례나
 * 한 토막 정도다. 앱은 문장 단위로 다루니 여기서 한 번 펴 준다. 그다음은
 * 다른 엔진과 똑같이 문장 나누기 → 병동 사전 교정으로 간다.
 *
 * 여기 있는 판단 두 개가 중요하다.
 *  - **잠긴 문단(locked)** 은 티로 무료 한도로 글자가 가려져 온다. 길이와 모양만
 *    같고 뜻은 없는 글자라, 넣으면 전사본이 통째로 망가진다. 세어서 알리고 버린다.
 *  - **화자 이름은 안 가져온다.** 티로에서 화자에 사람 이름을 붙여 뒀으면
 *    personName 으로 오는데 그건 병동 사람의 실명일 수 있다. 이 앱은 화자를 따로
 *    지정하게 되어 있으니 기계 이름표(SPEAKER_0)만 쓴다.
 */

/** 티로가 주는 문단. 이 변환에 필요한 것만 적는다. */
export interface TiroParagraph {
  /** ISO 시각. 녹음이 아닌 노트에는 없다. */
  timeFrom?: string | null;
  timeTo?: string | null;
  /** 참이면 티로 무료 한도로 글자가 가려진 문단이다. */
  locked?: boolean;
  transcript?: { content?: string } | null;
  diarizedSegments?:
    | {
        content?: string;
        /** personName 도 올 수 있지만 쓰지 않는다 — 위 주석 참고. */
        speaker?: { label?: string; personName?: string | null };
      }[]
    | null;
}

/** 앱의 ASR 결과와 같은 모양의 조각. */
export interface TiroSegment {
  startSec: number;
  endSec: number;
  text: string;
  speakerId?: string;
}

/**
 * 문단들을 조각으로 편다.
 *
 * @param baseMs 시각 기준점(epoch ms). 보통 첫 문단이 시작한 시각이다.
 * @returns 조각들과, 잠겨서 버린 문단 수.
 */
export function tiroParagraphsToSegments(
  paragraphs: TiroParagraph[],
  baseMs: number,
): { segments: TiroSegment[]; locked: number } {
  const segments: TiroSegment[] = [];
  let locked = 0;
  // 시각이 없는 문단은 앞 문단이 끝난 자리에 세운다.
  let cursorSec = 0;

  for (const p of paragraphs) {
    if (p.locked) {
      locked++;
      continue;
    }
    const fromMs = p.timeFrom ? Date.parse(p.timeFrom) : Number.NaN;
    const toMs = p.timeTo ? Date.parse(p.timeTo) : Number.NaN;
    const startSec = Number.isFinite(fromMs) ? Math.max(0, (fromMs - baseMs) / 1000) : cursorSec;
    const endSec = Number.isFinite(toMs) ? Math.max(startSec, (toMs - baseMs) / 1000) : startSec;

    const diar = (p.diarizedSegments ?? []).filter((d) => (d.content ?? "").trim());
    if (diar.length > 0) {
      // 문단 안 조각에는 저마다의 시각이 없다. 글자 수 비율로 문단 구간을 나눠
      // 준다 — 문장을 눌렀을 때 대략 그 자리를 가리키면 된다.
      const total = diar.reduce((n, d) => n + (d.content ?? "").length, 0) || 1;
      let at = startSec;
      for (const d of diar) {
        const span = ((endSec - startSec) * (d.content ?? "").length) / total;
        segments.push({
          startSec: at,
          endSec: at + span,
          text: (d.content ?? "").trim(),
          speakerId: d.speaker?.label,
        });
        at += span;
      }
    } else {
      const text = (p.transcript?.content ?? "").trim();
      if (text) segments.push({ startSec, endSec, text });
    }
    cursorSec = endSec;
  }
  return { segments, locked };
}
