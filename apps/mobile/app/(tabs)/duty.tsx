import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import {
  DEFAULT_TEMPLATES,
  createSchedule,
  parseDutyString,
  resolveAll,
  taeumTemperature,
  toDateString,
  type DutyEntry,
  type ShiftCode,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Row, Small, HeaderScreen } from "../../src/components/ui";
import { radius, space, type, useTheme, TOUCH_MIN } from "../../src/theme";
import {
  deleteDutyEntry,
  listDutyEntries,
  listTaeumScores,
  upsertDutyEntries,
} from "../../src/db";
import { useApp } from "../../src/state/AppContext";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 달력 셀에 들어가는 한 글자. 두 글자는 셀에서 넘친다. */
const SHORT: Record<ShiftCode, string> = {
  D: "데", E: "이", N: "나", OFF: "오",
  ADM: "상", SPC: "스", EDU: "교", ANNUAL: "연", SICK: "병", OTHER: "·",
};

/** 달력에서 바로 찍을 코드. 첫 줄이 3교대, 둘째 줄이 나머지. */
const CODE_ROWS: ShiftCode[][] = [
  ["D", "E", "N", "OFF"],
  ["ADM", "SPC", "ANNUAL", "EDU", "SICK"],
];

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "2026-08-24" 에 일수를 더한다. 자동으로 다음날로 넘어가는 데 쓴다. */
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
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [startDate, setStartDate] = useState(toDateString(Date.now()));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setEntries(await listDutyEntries());
    // 근무 기록의 태움 점수를 체온으로 바꿔 날짜에 얹는다.
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
      // 듀티표는 한 달을 연달아 찍는다. 찍자마자 다음날로 넘어가야
      // 달력을 다시 누를 필요 없이 쭉 입력할 수 있다.
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

  const applyPaste = useCallback(async () => {
    setError(null);
    try {
      const parsed = parseDutyString(startDate, pasteText);
      if (parsed.length === 0) return;
      await upsertDutyEntries(parsed);
      setPasteText("");
      await load();
      await app.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "붙여넣기를 읽지 못했습니다.");
    }
  }, [app, load, pasteText, startDate]);

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

  const selEntry = byDate.get(selected);
  const selShift = resolved.get(selected);
  const selTemp = temps.get(selected);
  const workDays = entries.filter((e) => DEFAULT_TEMPLATES[e.code]?.isWorking).length;

  return (
    <HeaderScreen
      title="듀티표"
      heroLabel="등록된 근무"
      hero={`${workDays}일`}
      rows={[
        { label: "오프·연차", value: `${entries.length - workDays}일` },
        { label: "전체 입력", value: `${entries.length}일` },
      ]}
    >
      <Card>
        {/* 월 이동 */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="지난달"
            onPress={() => setMonthAnchor(new Date(year, month - 1, 1))}
            style={{ minWidth: TOUCH_MIN, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={[type.heading, { color: t.textMuted }]}>‹</Text>
          </Pressable>
          <Text style={[type.heading, { color: t.text }]}>
            {year}년 {month + 1}월
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="다음달"
            onPress={() => setMonthAnchor(new Date(year, month + 1, 1))}
            style={{ minWidth: TOUCH_MIN, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={[type.heading, { color: t.textMuted }]}>›</Text>
          </Pressable>
        </View>

        {/* 요일 */}
        <View style={{ flexDirection: "row" }}>
          {WEEKDAYS.map((w, i) => (
            <Text
              key={w}
              style={[
                type.caption,
                {
                  flex: 1,
                  textAlign: "center",
                  color: i === 0 ? t.danger : i === 6 ? t.accent : t.textMuted,
                },
              ]}
            >
              {w}
            </Text>
          ))}
        </View>

        {/* 날짜 */}
        {Array.from({ length: cells.length / 7 }, (_, row) => (
          <View key={row} style={{ flexDirection: "row" }}>
            {cells.slice(row * 7, row * 7 + 7).map((date, col) => {
              if (!date) return <View key={col} style={{ flex: 1, height: 54 }} />;
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
                    height: 54,
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 2,
                    borderRadius: radius.md,
                    borderWidth: isSelected ? 2 : 0,
                    borderColor: t.accent,
                    backgroundColor: isToday ? t.surfaceAlt : "transparent",
                  }}
                >
                  <Text
                    style={[
                      type.caption,
                      { color: col === 0 ? t.danger : t.text, fontWeight: isToday ? "700" : "600" },
                    ]}
                  >
                    {Number(date.slice(-2))}
                  </Text>
                  {entry ? (
                    <View
                      style={{
                        minWidth: 20,
                        paddingHorizontal: 3,
                        borderRadius: radius.sm,
                        backgroundColor: codeColor(entry.code),
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ fontSize: 11, lineHeight: 15, color: "#FFFFFF", fontWeight: "700" }}>
                        {SHORT[entry.code]}
                      </Text>
                    </View>
                  ) : (
                    <View style={{ height: 15 }} />
                  )}
                  {/* 그 근무의 태움 체온. 점 하나가 한 근무의 기록이다. */}
                  <View
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 3,
                      backgroundColor: temp ? toneColor[temp.tone] : "transparent",
                    }}
                  />
                </Pressable>
              );
            })}
          </View>
        ))}

        <Divider />

        {/* 선택한 날에 코드 찍기. 찍으면 다음날로 넘어간다. */}
        <Small muted={false}>
          {selected.replace(/-/g, ".")} ({WEEKDAYS[new Date(`${selected}T00:00:00`).getDay()]}
  ) — 누르면 다음 날로 넘어갑니다
</Small>
        {CODE_ROWS.map((rowCodes, i) => (
          <View key={i} style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
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
                  <Text style={{ color: on ? "#FFFFFF" : t.text, fontWeight: "700", fontSize: 14 }}>
                    {DEFAULT_TEMPLATES[code].label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
        {selEntry ? (
          <Button label="이 날 지우기" onPress={() => void clearDay(selected)} />
        ) : null}
      </Card>

      {/* 선택한 날의 내용 */}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Heading>
            {selShift
              ? `${selShift.label} ${formatClock(selShift.startAt)}~${formatClock(selShift.endAt)}`
              : selEntry
                ? DEFAULT_TEMPLATES[selEntry.code].label
                : "근무 없음"}
          </Heading>
          {selTemp ? <Badge text={`${selTemp.celsius}°C ${selTemp.label}`} tone={selTemp.tone} /> : null}
        </View>
        {selShift ? (
          <>
            <Small>
              인계 포함 실제 체류 예상 {formatClock(selShift.onSiteStartAt)}~
              {formatClock(selShift.onSiteEndAt)}
            </Small>
            <Button
              label="이 근무 기록 보기"
              onPress={() => router.push(`/shift/${encodeURIComponent(selShift.id)}`)}
            />
          </>
        ) : null}
        {selTemp ? <Small>{selTemp.description}</Small> : null}
      </Card>

      {/* 붙여넣기 — 종이 듀티표를 통째로 넣을 때만 펼친다 */}
      <Card>
        <Row
          onPress={() => setPasteOpen((v) => !v)}
          label="듀티표 통째로 붙여넣기"
          value={pasteOpen ? "접기" : "펼치기"}
        />
        {pasteOpen ? (
          <View style={{ gap: space.sm }}>
            <Small>
              
  `DDEENNOO`, `데데이이나나오오`, `상상상상상오오` 형식을 모두 인식합니다. 첫 글자가 시작 날짜가 됩니다.
</Small>
            <Text style={[type.small, { color: t.textMuted }]}>시작 날짜</Text>
            <TextInput
              value={startDate}
              onChangeText={setStartDate}
              placeholder="2026-08-01"
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              style={{
                color: t.text,
                backgroundColor: t.surfaceAlt,
                borderRadius: radius.md,
                padding: space.md,
                fontSize: 15,
              }}
            />
            <TextInput
              value={pasteText}
              onChangeText={setPasteText}
              placeholder="DDEENNOO..."
              placeholderTextColor={t.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              multiline
              style={{
                color: t.text,
                backgroundColor: t.surfaceAlt,
                borderRadius: radius.md,
                padding: space.md,
                fontSize: 15,
                minHeight: 80,
              }}
            />
            {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
            <Button label="적용" tone="primary" onPress={() => void applyPaste()} />
          </View>
        ) : null}
      </Card>

      <Card>
        <Heading>근무 시간 설정</Heading>
        <Small>
          
  병원마다 근무 시간이 다릅니다. 아래는 현재 적용 중인 기본값이며, 스페셜은 임시 설정값입니다.
</Small>
        {(["D", "E", "N", "ADM", "SPC"] as ShiftCode[]).map((code) => {
          const tpl = DEFAULT_TEMPLATES[code];
          return (
            <View key={code}>
              <View
                style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: space.sm }}
              >
                <Body>{tpl.label}</Body>
                <Small>
                  {tpl.startTime}~{tpl.endTime} · 인계 앞 {tpl.preHandoverMin}분 / 뒤{" "}
                  {tpl.postHandoverMin}분
                </Small>
              </View>
              <Divider />
            </View>
          );
        })}
      </Card>
    </HeaderScreen>
  );
}
