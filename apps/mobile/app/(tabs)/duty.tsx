import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  DEFAULT_TEMPLATES,
  createSchedule,
  dutyPatternStats,
  resolveAll,
  taeumTemperature,
  toDateString,
  type DutyEntry,
  type ShiftCode,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../../src/components/ui";
import { CONTENT_MAX, TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  deleteDutyEntry,
  listDutyEntries,
  listTaeumScores,
  upsertDutyEntries,
} from "../../src/db";
import { useApp } from "../../src/state/AppContext";
import { exportMonthToCalendar, importMonthFromCalendar } from "../../src/services/calendar-sync";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 달력 칩에 쓰는 짧은 이름. 셀 폭 안에서 읽혀야 한다. */
const CHIP: Record<ShiftCode, string> = {
  D: "데이", E: "이브닝", N: "나이트", OFF: "오프",
  ADM: "상근", SPC: "스페셜", EDU: "교육", ANNUAL: "연차", SICK: "병가", OTHER: "기타",
};

const CODE_ROWS: ShiftCode[][] = [
  ["D", "E", "N", "OFF"],
  ["ADM", "SPC", "ANNUAL", "EDU", "SICK"],
];

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return toDateString(new Date(y, m - 1, d + days).getTime());
}

export default function Duty() {
  const t = useTheme();
  const app = useApp();
  const router = useRouter();
  const [entries, setEntries] = useState<DutyEntry[]>([]);
  const [temps, setTemps] = useState<Map<string, ReturnType<typeof taeumTemperature>>>(new Map());
  const [selected, setSelected] = useState(toDateString(Date.now()));
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setEntries(await listDutyEntries());
    const scores = await listTaeumScores(120);
    const map = new Map<string, ReturnType<typeof taeumTemperature>>();
    for (const s of scores) {
      const date = s.shiftId.split(":")[0];
      if (!map.has(date)) map.set(date, taeumTemperature(s.score));
    }
    setTemps(map);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => new Map(entries.map((e) => [e.date, e])), [entries]);
  const schedule = useMemo(() => createSchedule(entries), [entries]);
  const resolved = useMemo(
    () => new Map(resolveAll(schedule).map((s) => [s.date, s])),
    [schedule],
  );

  const setCode = useCallback(
    async (date: string, code: ShiftCode) => {
      await upsertDutyEntries([{ date, code }]);
      // 듀티표는 한 달을 연달아 찍는다. 찍자마자 다음날로.
      setSelected(addDays(date, 1));
      await load();
      await app.refresh();
    },
    [app, load],
  );

  const clearDay = useCallback(
    async (date: string) => {
      await deleteDutyEntry(date);
      await load();
      await app.refresh();
    },
    [app, load],
  );

  // ── 달력 그리드 ──
  const year = monthAnchor.getFullYear();
  const month = monthAnchor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = toDateString(Date.now());

  const cells: (string | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      toDateString(new Date(year, month, i + 1).getTime()),
    ),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const codeColor = (code: ShiftCode): string => {
    if (code === "D") return t.ok;
    if (code === "E") return t.warn;
    if (code === "N") return t.night;
    if (code === "ADM" || code === "SPC" || code === "EDU") return t.accent;
    return t.textMuted;
  };

  const toneColor = { ok: t.ok, muted: t.textMuted, warn: t.warn, danger: t.danger } as const;

  // ── 이번 달 통계 ──
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthEntries = entries.filter((e) => e.date.startsWith(monthPrefix));
  const counts = new Map<ShiftCode, number>();
  for (const e of monthEntries) counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
  const monthShifts = [...resolved.values()].filter((s) => s.date.startsWith(monthPrefix));
  const monthHours = Math.round(monthShifts.reduce((a, s) => a + (s.endAt - s.startAt), 0) / 360000) / 10;
  const nightCount = counts.get("N") ?? 0;
  const weekendWork = monthShifts.filter((s) => {
    const dow = new Date(s.startAt).getDay();
    return dow === 0 || dow === 6;
  }).length;
  // 최장 연속 근무
  let longestRun = 0;
  {
    const workDates = new Set(monthEntries.filter((e) => DEFAULT_TEMPLATES[e.code]?.isWorking).map((e) => e.date));
    let run = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = toDateString(new Date(year, month, d).getTime());
      run = workDates.has(ds) ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
    }
  }
  const workDayCount = monthEntries.filter((e) => DEFAULT_TEMPLATES[e.code]?.isWorking).length;
  const patterns = dutyPatternStats(monthEntries);

  const selEntry = byDate.get(selected);
  const selShift = resolved.get(selected);
  const selTemp = temps.get(selected);

  const statOrder: ShiftCode[] = ["D", "E", "N", "ADM", "SPC", "EDU", "ANNUAL", "SICK", "OFF"];
  const statTotal = monthEntries.length || 1;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      {/* 코드 버튼 시트가 탭바에 잘리지 않게 바닥 여백을 넉넉히 둔다. */}
      <ScrollView
        contentContainerStyle={{
          paddingBottom: space.bottom + 48,
          width: "100%",
          maxWidth: CONTENT_MAX,
          alignSelf: "center",
        }}
      >
        {/* 머리 — 삼성 캘린더처럼 월이 곧 제목이다 */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: space.lg,
            paddingTop: space.xs,
            paddingBottom: space.xs,
            gap: space.sm,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="지난달"
            onPress={() => setMonthAnchor(new Date(year, month - 1, 1))}
            style={{ minWidth: 40, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="chevron-back" size={20} color={t.textMuted} />
          </Pressable>
          <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: "700", color: t.text }}>
            {month + 1}월
          </Text>
          {year !== new Date().getFullYear() ? (
            <Text style={[type.small, { color: t.textMuted }]}>{year}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="다음달"
            onPress={() => setMonthAnchor(new Date(year, month + 1, 1))}
            style={{ minWidth: 40, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="chevron-forward" size={20} color={t.textMuted} />
          </Pressable>
          <View style={{ flex: 1 }} />
          {/* 오늘로 — 삼성처럼 날짜 숫자가 버튼이다 */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="오늘로 이동"
            onPress={() => {
              const now = new Date();
              setMonthAnchor(new Date(now.getFullYear(), now.getMonth(), 1));
              setSelected(toDateString(Date.now()));
            }}
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              borderWidth: 1.5,
              borderColor: t.textMuted,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={[type.small, TABULAR, { color: t.text, fontWeight: "700" }]}>
              {new Date().getDate()}
            </Text>
          </Pressable>
        </View>

        {/* 요일 */}
        <View style={{ flexDirection: "row", paddingHorizontal: space.xs }}>
          {WEEKDAYS.map((w, i) => (
            <Text
              key={w}
              style={[
                type.caption,
                {
                  flex: 1,
                  textAlign: "center",
                  color: i === 0 ? t.danger : i === 6 ? t.night : t.textMuted,
                },
              ]}
            >
              {w}
            </Text>
          ))}
        </View>

        {/* 날짜 그리드 — 코드 시트가 스크롤 없이 같이 보여야 하므로 셀을 조인다 */}
        <View style={{ paddingHorizontal: space.xs, paddingTop: space.xs }}>
          {Array.from({ length: cells.length / 7 }, (_, row) => (
            <View key={row} style={{ flexDirection: "row" }}>
              {cells.slice(row * 7, row * 7 + 7).map((date, col) => {
                if (!date) return <View key={col} style={{ flex: 1, height: 58 }} />;
                const entry = byDate.get(date);
                const temp = temps.get(date);
                const isSelected = date === selected;
                const isToday = date === today;
                return (
                  <Pressable
                    key={col}
                    accessibilityRole="button"
                    onPress={() => setSelected(date)}
                    style={{
                      flex: 1,
                      height: 58,
                      borderRadius: radius.md,
                      borderWidth: isToday ? 1.5 : 0,
                      borderColor: t.text,
                      backgroundColor: isSelected ? t.surfaceAlt : "transparent",
                      paddingTop: 3,
                      gap: 2,
                    }}
                  >
                    <Text
                      style={[
                        type.caption,
                        TABULAR,
                        {
                          textAlign: "center",
                          color: col === 0 ? t.danger : col === 6 ? t.night : t.text,
                        },
                      ]}
                    >
                      {Number(date.slice(-2))}
                    </Text>
                    {entry ? (
                      <View
                        style={{
                          marginHorizontal: 2,
                          borderRadius: 4,
                          backgroundColor: codeColor(entry.code),
                          paddingVertical: 1.5,
                        }}
                      >
                        <Text
                          numberOfLines={1}
                          style={{ fontSize: 10, lineHeight: 14, color: "#FFFFFF", fontWeight: "700", textAlign: "center" }}
                        >
                          {CHIP[entry.code]}
                        </Text>
                      </View>
                    ) : null}
                    {temp ? (
                      <View
                        style={{
                          alignSelf: "center",
                          width: 5,
                          height: 5,
                          borderRadius: 3,
                          backgroundColor: toneColor[temp.tone],
                        }}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        {/* 선택한 날 + 코드 찍기 */}
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md }}>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Heading>
                {Number(selected.slice(5, 7))}월 {Number(selected.slice(-2))}일 (
                {WEEKDAYS[new Date(`${selected}T00:00:00`).getDay()]})
              </Heading>
              {selTemp ? <Badge text={`${selTemp.celsius}°C`} tone={selTemp.tone} /> : null}
            </View>
            {selShift ? (
              <Small>
                {selShift.label} {formatClock(selShift.startAt)}~{formatClock(selShift.endAt)} ·
                실제 체류 예상 {formatClock(selShift.onSiteStartAt)}~{formatClock(selShift.onSiteEndAt)}
              </Small>
            ) : (
              <Small>
  누르면 다음 날로 넘어갑니다. 한 달을 연속 선택하십시오.
</Small>
            )}
            {CODE_ROWS.map((rowCodes, i) => (
              <View key={i} style={{ flexDirection: "row", gap: space.sm }}>
                {rowCodes.map((code) => {
                  const on = selEntry?.code === code;
                  return (
                    <Pressable
                      key={code}
                      accessibilityRole="button"
                      onPress={() => void setCode(selected, code)}
                      style={{
                        flex: 1,
                        minHeight: TOUCH_MIN,
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: radius.md,
                        backgroundColor: on ? codeColor(code) : t.surfaceAlt,
                      }}
                    >
                      <Text style={{ color: on ? "#FFFFFF" : t.text, fontWeight: "700", fontSize: 13 }}>
                        {DEFAULT_TEMPLATES[code].label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {selShift ? (
                <View style={{ flex: 1 }}>
                  <Button
                    label="근무 기록"
                    onPress={() => router.push(`/shift/${encodeURIComponent(selShift.id)}`)}
                  />
                </View>
              ) : null}
              {selEntry ? (
                <View style={{ flex: 1 }}>
                  <Button label="지우기" onPress={() => void clearDay(selected)} />
                </View>
              ) : null}
            </View>
          </Card>

          {/* ── 이번 달 근무 통계 ── */}
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Heading>{month + 1}월 근무 통계</Heading>
              <Text style={[type.small, TABULAR, { color: t.textMuted }]}>
                {workDayCount}일 근무 · {monthHours}시간
              </Text>
            </View>
            {monthEntries.length === 0 ? (
              <Body muted>
  이번 달 듀티가 없습니다. 상단 달력에서 입력하십시오.
</Body>
            ) : (
              <>
                {/* 한 줄 누적 막대 — 이번 달이 어떤 색인지 한눈에 */}
                <View style={{ flexDirection: "row", height: 14, borderRadius: 7, overflow: "hidden" }}>
                  {statOrder.map((code) => {
                    const n = counts.get(code) ?? 0;
                    if (n === 0) return null;
                    return (
                      <View
                        key={code}
                        style={{ flex: n / statTotal, backgroundColor: code === "OFF" ? t.surfaceAlt : codeColor(code) }}
                      />
                    );
                  })}
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                  {statOrder.map((code) => {
                    const n = counts.get(code) ?? 0;
                    if (n === 0) return null;
                    return (
                      <View key={code} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <View
                          style={{
                            width: 8, height: 8, borderRadius: 4,
                            backgroundColor: code === "OFF" ? t.textMuted : codeColor(code),
                          }}
                        />
                        <Text style={[type.small, { color: t.text }]}>
                          {DEFAULT_TEMPLATES[code].label} {n}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </>
            )}
          </Card>

          {/* ── 근무량 분석 ── */}
          {monthEntries.length > 0 ? (
            <Card>
              <Heading>근무량 분석</Heading>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                {[
                  { icon: "moon-outline" as const, label: "나이트", value: `${nightCount}번` },
                  { icon: "sunny-outline" as const, label: "주말 근무", value: `${weekendWork}번` },
                  { icon: "flame-outline" as const, label: "최장 연속", value: `${longestRun}일` },
                ].map((s) => (
                  <View
                    key={s.label}
                    style={{
                      flex: 1,
                      backgroundColor: t.surfaceAlt,
                      borderRadius: radius.lg,
                      paddingVertical: space.md,
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <Ionicons name={s.icon} size={18} color={t.textMuted} />
                    <Text style={[type.cardTitle, TABULAR, { color: t.text, fontWeight: "700" }]}>{s.value}</Text>
                    <Text style={[type.caption, { color: t.textMuted }]}>{s.label}</Text>
                  </View>
                ))}
              </View>
              {longestRun >= 5 ? (
                <Small muted={false}>연속 {longestRun}일 근무가 있습니다. 몸이 먼저입니다.</Small>
              ) : null}
              <Divider />
              <Small muted={false}>기피 듀티</Small>
              {[[
                  { label: "나오데", value: patterns.naode, hint: "나이트-오프-데이" },
                  { label: "이브데이", value: patterns.evday, hint: "이브닝 뒤 바로 데이" },
                  { label: "퐁당퐁당", value: patterns.pongdang, hint: "하루걸러 출근" },
                ], [
                  { label: "연속 근무", value: patterns.sameShiftRun, hint: "같은 근무 4일 이상" },
                  { label: "나이트 연속", value: patterns.longestNightRun, hint: "최장 연속 일수" },
                  { label: "샌드위치 오프", value: patterns.sandwichOff, hint: "나이트-오프-나이트" },
                ]].map((rowTiles, ri) => (
              <View key={ri} style={{ flexDirection: "row", gap: space.sm }}>
                {rowTiles.map((s2) => (
                  <View
                    key={s2.label}
                    style={{
                      flex: 1,
                      backgroundColor: s2.value > 0 ? t.accentSoft : t.surfaceAlt,
                      borderRadius: radius.lg,
                      paddingVertical: space.md,
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    <Text style={[type.cardTitle, TABULAR, { color: s2.value > 0 ? t.warn : t.text, fontWeight: "700" }]}>
                      {s2.value}번
                    </Text>
                    <Text style={[type.caption, { color: t.text }]}>{s2.label}</Text>
                    <Text style={[type.caption, { color: t.textMuted, fontWeight: "400" }]}>{s2.hint}</Text>
                  </View>
                ))}
              </View>
              ))}
              {patterns.naode + patterns.evday + patterns.sameShiftRun + patterns.sandwichOff > 0 ||
              patterns.longestNightRun > 3 ? (
                <Small>
                  연속 5일이나 나이트 3일을 넘는 일정입니다. 계속되면 근무표를 기록해 두십시오.
                </Small>
              ) : null}
            </Card>
          ) : null}

          {/* ── 폰 캘린더 연동 ── */}
          <Card>
            <Heading>
  폰 캘린더 내보내기
</Heading>
            <Small>
              
  기기 캘린더의 근무 일정을 가져오거나, 이번 달 듀티표를 캘린더로 내보냅니다.
</Small>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="캘린더에서 불러오기"
                  tone="primary"
                  onPress={async () => {
                    try {
                      const r = (await importMonthFromCalendar(year, month)) as {
                        ok: boolean;
                        message: string;
                        entries?: { date: string; code: ShiftCode }[];
                      };
                      if (r.entries?.length) {
                        await upsertDutyEntries(r.entries);
                        await load();
                        await app.refresh();
                      }
                      setSyncMsg(r.message);
                    } catch (e) {
                      // 실패가 조용히 사라지면 '버튼이 안 먹는다'로 보인다.
                      setSyncMsg(e instanceof Error ? e.message : "가져오지 못했습니다.");
                    }
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label={`${month + 1}월 내보내기`}
                  onPress={async () => {
                    const r = await exportMonthToCalendar(entries, year, month);
                    setSyncMsg(r.message);
                  }}
                />
              </View>
            </View>
            {syncMsg ? <Small muted={false}>{syncMsg}</Small> : null}
          </Card>

          {/* 근무 시간 기본값 */}
          <Card>
            <Heading>근무 시간 설정</Heading>
            {(["D", "E", "N", "ADM", "SPC"] as ShiftCode[]).map((code) => {
              const tpl = DEFAULT_TEMPLATES[code];
              return (
                <View key={code}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: space.sm }}>
                    <Body>{tpl.label}</Body>
                    <Small>
                      {tpl.startTime}~{tpl.endTime} · 인계 앞 {tpl.preHandoverMin}분 / 뒤 {tpl.postHandoverMin}분
                    </Small>
                  </View>
                  <Divider />
                </View>
              );
            })}
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
