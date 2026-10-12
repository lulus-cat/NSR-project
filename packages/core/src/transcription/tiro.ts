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

/** 티로 노트 목록의 한 줄 — 짝짓기에 필요한 것만. */
export interface UploadNote {
  guid: string;
  title: string;
  /** 티로 OpenAPI 의 sourceType. 파일을 올려 만든 노트는 "recording". */
  source: string;
  /** 노트가 생긴 시각(epoch ms). 올린 파일은 티로가 다 받아적은 뒤에 생긴다. */
  createdAt: number;
  durationSec: number;
}

/** 티로로 보내고 글자를 기다리는 이 앱의 녹음. */
export interface SentRecording {
  id: string;
  shiftId: string;
  /** 녹음이 끝난 시각(epoch ms). */
  endedAt: number;
  durationSec: number;
  /** 파일 이름에서 확장자를 뺀 것 (2026-10-12_D__000). 티로가 제목으로 쓰면 그대로 남는다. */
  fileStem?: string;
  /**
   * 참이면 제목(파일 이름)으로만 짝짓는다. '보냈다' 표시가 안 된 녹음이다 — 공유 창이
   * 표시를 못 남겼을 수 있지만, 길이만 같다고 붙이기엔 보냈는지조차 모른다.
   */
  titleOnly?: boolean;
}

/** 시계가 어긋나도 놓치지 않게 — 노트가 녹음 끝보다 조금 일러 보여도 받는다. */
const CLOCK_SLACK_MS = 2 * 60_000;

/**
 * 티로에 올린 파일로 만들어진 노트를 이 앱의 녹음과 짝짓는다.
 *
 * 녹음을 티로로 보낸 뒤 사람이 '티로 노트에서 글자 가져오기' 에서 날짜·듀티·노트를
 * 손으로 골라야 다음(서버 → 클로드 분석)으로 갔다. 그 단계가 어디에도 안 보여서
 * 티로에 글자가 다 있는데 근무 기록은 비어 있었다(10월 12일). 이 짝으로 저절로 데려온다.
 *
 * **틀리게 붙이느니 안 붙인다.** 남의 날 글이 근무에 섞이면 보고서까지 틀린다.
 *  - 파일을 올려 만든 노트(sourceType recording)만 본다. 티로 앱으로 직접 녹음한
 *    노트는 이 앱의 녹음이 아니다 — 그건 지금처럼 손으로 가져온다.
 *  - 제목에 파일 이름이 남아 있으면 그것이 답이다.
 *  - 아니면 녹음이 **끝난 뒤에** 생겼고 길이가 거의 같아야 한다(±max(10초, 1%)).
 *  - 짝이 되는 녹음이 **한 근무 안에만** 있을 때만 붙인다. 같은 근무의 조각끼리는
 *    어느 쪽에 붙어도 같은 근무라 괜찮지만, 두 근무에 걸리면 고를 근거가 없다.
 * 먼저 생긴 노트부터 짝짓고, 짝지은 녹음은 다시 안 쓴다 — 같은 파일을 두 번 올려도
 * 한 번만 들어온다.
 */
export function matchTiroUploads(
  notes: UploadNote[],
  recordings: SentRecording[],
): { noteGuid: string; recordingId: string; shiftId: string }[] {
  const free = new Map(recordings.map((r) => [r.id, r]));
  const pairs: { noteGuid: string; recordingId: string; shiftId: string }[] = [];
  const uploads = notes
    .filter((n) => n.source === "recording")
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const n of uploads) {
    const pool = [...free.values()];
    let hits = pool.filter((r) => r.fileStem && n.title.includes(r.fileStem));
    if (hits.length === 0) {
      hits = pool.filter(
        (r) =>
          !r.titleOnly &&
          n.createdAt >= r.endedAt - CLOCK_SLACK_MS &&
          Math.abs(n.durationSec - r.durationSec) <= Math.max(10, r.durationSec * 0.01),
      );
    }
    if (new Set(hits.map((r) => r.shiftId)).size !== 1) continue;
    const best = hits.reduce((a, b) =>
      Math.abs(b.durationSec - n.durationSec) < Math.abs(a.durationSec - n.durationSec) ? b : a,
    );
    pairs.push({ noteGuid: n.guid, recordingId: best.id, shiftId: best.shiftId });
    free.delete(best.id);
  }
  return pairs;
}
