/**
 * 내보낼 덩어리를 글자로 굽는 곳.
 *
 * 전사본·보고서·단어장·분석 원본을 각각 그 쓰임에 맞는 꼴로 만든다.
 * 여기서는 **가리지 않는다** — 마스킹은 나가는 길목(`export.ts`의
 * `redactForExport`) 한 곳에서만 한다. 두 군데서 가리면 어느 쪽이 실제로
 * 나갔는지 아무도 모르게 된다.
 *
 * 전사본 꼴을 이렇게 잡은 이유
 * --------------------------
 * 이 파일의 첫 쓰임새는 "휘스퍼가 잘못 들은 것을 AI로 고치는 규칙 만들기"다.
 * 그 일에는 **교정본과 ASR 원문의 차이**가 가장 중요한 재료라서, 둘이 다를
 * 때만 원문을 한 줄 더 붙인다. 같은 줄을 두 번 적으면 파일만 두 배가 된다.
 */
import type { Card, SpeakerRole, TranscriptSegment } from "@nsr/core";

/** 화자 역할의 한국어 이름. 전사 화면(transcript/[id].tsx)과 같은 말을 쓴다. */
const ROLE_TEXT: Record<SpeakerRole, string> = {
  self: "본인",
  senior: "선배",
  doctor: "의사",
  patient: "대상자",
  guardian: "보호자",
  other: "기타",
  unknown: "미확인",
};

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(r)}`;
}

function stamp(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** 파일 이름의 앞머리. 어느 근무 것인지 파일명만 봐도 알게 한다. */
export function exportBaseName(date: string | undefined, dutyLabel: string): string {
  return `${date ?? "근무"}-${dutyLabel}`;
}

/**
 * 전사본 → 텍스트.
 *
 * 형식은 사람이 읽기에도, AI 에게 통째로 물리기에도 무리 없는 줄 단위다.
 */
export function transcriptToText(
  segments: TranscriptSegment[],
  meta: { date?: string; dutyLabel: string },
): string {
  const head = [
    `# ${meta.date ?? "날짜 미상"} · ${meta.dutyLabel} 전사본`,
    `# 문장 ${segments.length}개 · 내보낸 시각 ${stamp()}`,
    "# 형식: [시:분:초] 화자 | 문장",
    '#   교정본이 ASR 원문과 다르면 다음 줄에 "  (원문) ..." 를 함께 둡니다.',
    "",
  ];
  const body = segments.flatMap((s) => {
    const who = ROLE_TEXT[s.speakerRole ?? "unknown"] ?? s.speakerId ?? "미확인";
    const line = `[${clock(s.startSec)}] ${who} | ${s.text.trim()}`;
    const raw = s.rawText.trim();
    return raw && raw !== s.text.trim() ? [line, `  (원문) ${raw}`] : [line];
  });
  return [...head, ...body, ""].join("\n");
}

function csvCell(value: string): string {
  const v = value.replace(/\r?\n/g, " ").trim();
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * 단어장 → CSV.
 *
 * 앞면·뒷면을 앞에 두는 것은 앙키(Anki)를 비롯한 암기 앱이 그 차례를 기본으로
 * 읽기 때문이다. 뒤 칸은 무시하고 두 칸만 가져가도 그대로 쓸 수 있다.
 */
export function cardsToCsv(cards: Card[]): string {
  const rows = [["앞면", "뒷면", "종류", "맥락", "근거id"].join(",")];
  for (const c of cards) {
    rows.push(
      [c.front, c.back, c.kind, c.context ?? "", c.sourceIds.join(" ")].map(csvCell).join(","),
    );
  }
  return rows.join("\n") + "\n";
}

/**
 * 심층 분석 원본 → JSON.
 *
 * 화면에 보이는 보고서는 이 원본을 사람이 읽게 줄인 것이다. 교정 규칙을
 * 만들 때 필요한 것은 줄이기 전 쪽이라, 단계별 결과를 그대로 담는다.
 */
export function analysisToJson(input: {
  shiftId: string;
  date?: string;
  dutyLabel: string;
  markdown: string | null;
  payload: unknown;
  confirmations: unknown[];
}): string {
  return JSON.stringify(
    {
      근무: { shiftId: input.shiftId, 날짜: input.date ?? null, 듀티: input.dutyLabel },
      내보낸시각: stamp(),
      보고서_마크다운: input.markdown,
      분석: input.payload,
      확인목록: input.confirmations,
    },
    null,
    2,
  );
}
