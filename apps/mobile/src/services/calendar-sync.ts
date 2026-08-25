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
import * as Calendar from "expo-calendar";
import { createSchedule, resolveAll, type DutyEntry } from "@nsr/core";

const CAL_NAME = "NSR 듀티";

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
  if (!calId) return { ok: false, count: 0, message: "캘린더 권한이 필요합니다." };

  const monthStart = new Date(year, month0, 1);
  const monthEnd = new Date(year, month0 + 1, 1);

  // 이 앱이 만든 캘린더 안이므로 통째로 지우고 다시 쓴다.
  const old = await Calendar.getEventsAsync([calId], monthStart, monthEnd);
  for (const e of old) await Calendar.deleteEventAsync(e.id);

  const shifts = resolveAll(createSchedule(entries)).filter(
    (s) => s.startAt >= monthStart.getTime() && s.startAt < monthEnd.getTime(),
  );
  for (const s of shifts) {
    await Calendar.createEventAsync(calId, {
      title: `${s.label} 근무`,
      startDate: new Date(s.startAt),
      endDate: new Date(s.endAt),
      notes: "NSR 듀티표에서 내보냄",
    });
  }
  return {
    ok: true,
    count: shifts.length,
    message: `${month0 + 1}월 근무 ${shifts.length}건을 '${CAL_NAME}' 캘린더에 넣었습니다.`,
  };
}
