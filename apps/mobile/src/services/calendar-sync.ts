/**
 * 듀티 → 폰 캘린더 내보내기.
 *
 * 방향은 한쪽뿐이다: 앱의 듀티표를 폰 캘린더에 **일정으로 쓴다.**
 * 반대로 폰 캘린더를 읽어 듀티를 채우는 것은 안 한다 — 캘린더에는
 * 생일·약속이 섞여 있어 무엇이 근무인지 앱이 구별할 수 없다.
 *
 * "NSR 듀티" 캘린더를 따로 만들어 그 안에만 쓴다. 다시 내보내면
 * 그 캘린더의 해당 월 일정을 지우고 새로 쓴다 — 수정보다 단순하고,
 * 남의 일정을 건드릴 일이 없다.
 */
// SDK 57 부터 expo-calendar 의 기본 export 는 새 객체지향 API 다. 옛 함수 API
// (requestCalendarPermissionsAsync 등)는 기본 경로에서 부르면 **거부**된다 —
// 실기기에서 '불러오기'가 deprecated 오류로 죽던 원인. legacy 경로가 옛 API 다.
import * as Calendar from "expo-calendar/legacy";
import { parseDutyString, resolveAll, toDateString, type DutyEntry } from "@nsr/core";
import { buildSchedule } from "./scheduler";

const CAL_NAME = "내 듀티표";

async function ensureCalendar(): Promise<string | null> {
  const { granted } = await Calendar.requestCalendarPermissionsAsync();
  if (!granted) return null;

  const existing = (await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)).find(
    (c) => c.title === CAL_NAME,
  );
  if (existing) return existing.id;

  const source =
    (await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)).find(
      (c) => c.accessLevel === Calendar.CalendarAccessLevel.OWNER,
    )?.source ?? { isLocalAccount: true, name: "NSR", type: Calendar.SourceType.LOCAL };

  return Calendar.createCalendarAsync({
    title: CAL_NAME,
    color: "#2F6F5E",
    entityType: Calendar.EntityTypes.EVENT,
    source: source as Calendar.Source,
    sourceId: (source as Calendar.Source & { id?: string }).id,
    name: CAL_NAME,
    ownerAccount: "NSR",
    accessLevel: Calendar.CalendarAccessLevel.OWNER,
  });
}

/** 해당 월의 듀티를 폰 캘린더에 쓴다. 결과는 쓴 일정 수. */
export async function exportMonthToCalendar(
  entries: DutyEntry[],
  year: number,
  month0: number,
): Promise<{ ok: boolean; count: number; message: string }> {
  const calId = await ensureCalendar();
  if (!calId) return { ok: false, count: 0, message: "달력 사용이 꺼져 있어요. 폰 설정에서 켜 주세요." };

  const monthStart = new Date(year, month0, 1);
  const monthEnd = new Date(year, month0 + 1, 1);

  // 이 앱이 만든 캘린더 안이므로 통째로 지우고 다시 쓴다.
  const old = await Calendar.getEventsAsync([calId], monthStart, monthEnd);
  for (const e of old) await Calendar.deleteEventAsync(e.id);

  const shifts = resolveAll(await buildSchedule(entries)).filter(
    (s) => s.startAt >= monthStart.getTime() && s.startAt < monthEnd.getTime(),
  );
  for (const s of shifts) {
    await Calendar.createEventAsync(calId, {
      title: `${s.label} 출근`,
      startDate: new Date(s.startAt),
      endDate: new Date(s.endAt),
      notes: "NSR 듀티표에서 보냈어요",
    });
  }
  return {
    ok: true,
    count: shifts.length,
    message: `${month0 + 1}월 듀티 ${shifts.length}개를 '${CAL_NAME}' 달력에 넣었어요.`,
  };
}

/**
 * 폰 캘린더에서 듀티 불러오기 — 방향이 사용자 쪽이다.
 *
 * 구글·삼성 캘린더에 이미 근무를 적어 둔 사람이 많다("데", "나이트", "D").
 * 그 달의 모든 일정을 읽어 **제목이 근무 코드로 읽히는 것만** 듀티로 만든다.
 * 제목 해석은 붙여넣기와 같은 사전(parseDutyString)을 쓰므로
 * 데/데이/D/나/오프/휴 전부 알아듣는다. 그 외 일정(생일·약속)은 건드리지 않는다.
 */
export async function importMonthFromCalendar(
  year: number,
  month0: number,
): Promise<{ ok: boolean; count: number; message: string }> {
  const { granted } = await Calendar.requestCalendarPermissionsAsync();
  if (!granted) return { ok: false, count: 0, message: "달력 사용이 꺼져 있어요. 폰 설정에서 켜 주세요." };

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  // 우리가 내보낸 캘린더는 제외 — 되돌아 들어오면 메아리가 된다.
  const sourceIds = calendars.filter((c) => c.title !== CAL_NAME).map((c) => c.id);
  const monthStart = new Date(year, month0, 1);
  const monthEnd = new Date(year, month0 + 1, 1);
  const events = await Calendar.getEventsAsync(sourceIds, monthStart, monthEnd);

  const entries: DutyEntry[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const title = (ev.title ?? "").trim();
    if (!title || title.length > 6) continue; // 근무 코드는 짧다. 긴 제목은 일정이다.
    // parseDutyString 은 모르는 글자에서 예외를 던진다. "회의" 같은 짧은
    // 일반 일정 하나가 전체 가져오기를 죽이면 안 되므로 개별로 삼킨다.
    let parsed;
    try {
      parsed = parseDutyString("2026-01-01", title);
    } catch {
      continue; // 근무 코드가 아닌 제목이다. 건너뛴다.
    }
    if (parsed.length !== 1) continue; // 정확히 코드 하나로 읽힐 때만
    const date = toDateString(new Date(ev.startDate as string | number | Date).getTime());
    if (!date.startsWith(`${year}-${String(month0 + 1).padStart(2, "0")}`)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    entries.push({ date, code: parsed[0].code });
  }
  return {
    ok: true,
    count: entries.length,
    message:
      entries.length > 0
        ? `${month0 + 1}월 달력에서 듀티 ${entries.length}개를 가져왔어요.`
        : "가져올 듀티가 없어요. 달력 일정 이름이 '데이'나 'N' 처럼 듀티여야 해요.",
    ...(entries.length > 0 ? { entries } : {}),
  } as { ok: boolean; count: number; message: string; entries?: DutyEntry[] };
}
