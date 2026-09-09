/**
 * 달 하나짜리 날짜 고르개.
 *
 * 가져오기 화면이 열나흘짜리 가로 줄만 주던 것을 대신한다 — 지난달 근무를
 * 가져오려면 그 줄로는 닿을 수가 없었다.
 *
 * 칸 계산은 core 의 `monthCells` 가 한다(시험이 붙어 있다). 여기는 그리기만.
 * 듀티 탭의 달력은 통계·체온 점까지 얹혀 있어 그대로 두었다.
 */
import { monthCells } from "@nsr/core";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, Text, View } from "react-native";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../theme";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export interface DayMark {
  /** 칸 아래에 붙는 짧은 글자 (근무 코드 등). */
  label: string;
  color: string;
}

export function MonthGrid({
  year,
  month,
  onMonth,
  selected,
  onSelect,
  marks,
  today,
}: {
  year: number;
  /** 0 부터 센다 (자바스크립트 Date 와 같게). */
  month: number;
  onMonth: (year: number, month: number) => void;
  selected: string;
  onSelect: (date: string) => void;
  marks?: Map<string, DayMark>;
  today?: string;
}) {
  const t = useTheme();
  const cells = monthCells(year, month);
  const step = (by: number) => {
    const d = new Date(year, month + by, 1);
    onMonth(d.getFullYear(), d.getMonth());
  };

  return (
    <View style={{ gap: space.xs }}>
      {/* 달 넘기기 */}
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="지난달"
          onPress={() => step(-1)}
          style={({ pressed }) => ({
            minWidth: TOUCH_MIN,
            minHeight: TOUCH_MIN,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Ionicons name="chevron-back" size={20} color={t.text} />
        </Pressable>
        <Text style={[type.cardTitle, TABULAR, { flex: 1, textAlign: "center", color: t.text }]}>
          {year}년 {month + 1}월
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="다음달"
          onPress={() => step(1)}
          style={({ pressed }) => ({
            minWidth: TOUCH_MIN,
            minHeight: TOUCH_MIN,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Ionicons name="chevron-forward" size={20} color={t.text} />
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
                color: i === 0 ? t.danger : i === 6 ? t.night : t.textMuted,
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
            if (!date) return <View key={col} style={{ flex: 1, height: 52 }} />;
            const on = date === selected;
            const mark = marks?.get(date);
            return (
              <Pressable
                key={col}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${month + 1}월 ${Number(date.slice(-2))}일`}
                onPress={() => onSelect(date)}
                style={{
                  flex: 1,
                  height: 52,
                  paddingTop: 4,
                  gap: 2,
                  borderRadius: radius.md,
                  borderWidth: date === today ? 1.5 : 0,
                  borderColor: t.text,
                  backgroundColor: on ? t.accent : "transparent",
                }}
              >
                <Text
                  style={[
                    type.caption,
                    TABULAR,
                    {
                      textAlign: "center",
                      color: on
                        ? "#FFFFFF"
                        : col === 0
                          ? t.danger
                          : col === 6
                            ? t.night
                            : t.text,
                    },
                  ]}
                >
                  {Number(date.slice(-2))}
                </Text>
                {mark ? (
                  <View
                    style={{
                      marginHorizontal: 2,
                      borderRadius: 4,
                      paddingVertical: 1.5,
                      backgroundColor: on ? "transparent" : mark.color,
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        fontSize: 10,
                        lineHeight: 14,
                        textAlign: "center",
                        fontWeight: "700",
                        color: "#FFFFFF",
                      }}
                    >
                      {mark.label}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
