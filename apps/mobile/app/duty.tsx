import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import {
  DEFAULT_TEMPLATES,
  createSchedule,
  parseDutyString,
  resolveAll,
  toDateString,
  type DutyEntry,
  type ShiftCode,
} from "@nsr/core";
import { Body, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { radius, space, type, useTheme } from "../src/theme";
import { deleteDutyEntry, listDutyEntries, upsertDutyEntries } from "../src/db";
import { useApp } from "../src/state/AppContext";

const QUICK_CODES: ShiftCode[] = ["D", "E", "N", "OFF"];

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export default function Duty() {
  const t = useTheme();
  const app = useApp();
  const [entries, setEntries] = useState<DutyEntry[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [startDate, setStartDate] = useState(toDateString(Date.now()));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setEntries(await listDutyEntries());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const setCode = useCallback(
    async (date: string, code: ShiftCode) => {
      await upsertDutyEntries([{ date, code }]);
      await load();
      await app.refresh();
    },
    [app, load],
  );

  const schedule = createSchedule(entries);
  const resolved = new Map(resolveAll(schedule).map((s) => [s.date, s]));

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Card>
        <Heading>듀티표 붙여넣기</Heading>
        <Small>
          병동에서 받은 근무표를 그대로 붙여넣으세요. `DDEENNOO`, `D D E E N N O O`,
          `데데이이나나오오` 모두 읽습니다. 첫 글자가 시작 날짜에 대응합니다.
        </Small>
        <View style={{ gap: space.sm }}>
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
          {error ? (
            <Text style={[type.small, { color: t.danger }]}>{error}</Text>
          ) : null}
          <Button label="적용" tone="primary" onPress={() => void applyPaste()} />
        </View>
      </Card>

      <Card>
        <Heading>근무 시간 설정</Heading>
        <Small>
          병원마다 근무 시간이 다릅니다. 아래는 현재 적용 중인 기본값입니다.
          인계 준비 시간이 실제 출근 시각을 만들고, 자동 녹음도 이 시각을 기준으로 앞당겨집니다.
        </Small>
        {(["D", "E", "N"] as ShiftCode[]).map((code) => {
          const tpl = DEFAULT_TEMPLATES[code];
          return (
            <View key={code}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: space.sm }}>
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

      <Card>
        <Heading>등록된 근무</Heading>
        {entries.length === 0 ? (
          <Body muted>아직 입력된 근무가 없습니다.</Body>
        ) : (
          entries.map((entry) => {
            const shift = resolved.get(entry.date);
            const dow = WEEKDAYS[new Date(`${entry.date}T00:00:00`).getDay()];
            return (
              <View key={entry.date} style={{ gap: space.sm, paddingVertical: space.sm }}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Body>
                    {entry.date} ({dow})
                  </Body>
                  <Small>
                    {shift
                      ? `${formatClock(shift.startAt)}~${formatClock(shift.endAt)}`
                      : "휴무"}
                  </Small>
                </View>
                <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                  {QUICK_CODES.map((code) => {
                    const on = entry.code === code;
                    return (
                      <Pressable
                        key={code}
                        accessibilityRole="button"
                        onPress={() => void setCode(entry.date, code)}
                        style={{
                          paddingVertical: space.xs,
                          paddingHorizontal: space.md,
                          borderRadius: radius.sm,
                          backgroundColor: on ? t.accent : t.surfaceAlt,
                        }}
                      >
                        <Text
                          style={{
                            color: on ? "#fff" : t.text,
                            fontWeight: "600",
                            fontSize: 13,
                          }}
                        >
                          {DEFAULT_TEMPLATES[code].label}
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    accessibilityRole="button"
                    onPress={async () => {
                      await deleteDutyEntry(entry.date);
                      await load();
                      await app.refresh();
                    }}
                    style={{
                      paddingVertical: space.xs,
                      paddingHorizontal: space.md,
                      borderRadius: radius.sm,
                    }}
                  >
                    <Text style={{ color: t.textMuted, fontSize: 13 }}>삭제</Text>
                  </Pressable>
                </View>
                <Divider />
              </View>
            );
          })
        )}
      </Card>
    </ScrollView>
  );
}
