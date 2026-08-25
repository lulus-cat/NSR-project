import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps } from "react";
import {
  createSchedule,
  dailyQuote,
  dueStates,
  laborStats,
  laborWarnings,
  resolveAll,
  taeumTemperature,
  toDateString,
  type ResolvedShift,
} from "@nsr/core";
import {
  Body,
  Card,
  DashedDivider,
  FolderCard,
  HeaderScreen,
  Small,
} from "../../src/components/ui";
import { useApp } from "../../src/state/AppContext";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  listDutyEntries,
  listReviewStates,
  listTaeumScores,
  pendingTranscriptions,
} from "../../src/db";
import { startManual, stopManual } from "../../src/services/scheduler";
import { checkForUpdate, type UpdateCheck } from "../../src/services/update";
import { listModels } from "../../src/services/models";

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function greeting(hour: number, todayCode?: string): string {
  if (todayCode === "N" && hour >= 19) return "오늘 밤도 무사히";
  if (hour >= 5 && hour < 11) return "좋은 아침입니다";
  if (hour >= 11 && hour < 17) return "좋은 오후입니다";
  if (hour >= 17 && hour < 22) return "좋은 저녁입니다";
  return "고요한 밤입니다";
}

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function koreanDate(now: Date): string {
  return `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS_KO[now.getDay()]}요일`;
}

/** 브리핑 한 줄 — 아이콘·라벨·값·화살표. ShopBack 체크리스트 행. */
function BriefRow({
  icon,
  label,
  value,
  valueColor,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  value: string;
  valueColor?: string;
  onPress?: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 40 }}
    >
      <Ionicons name={icon} size={18} color={t.textMuted} />
      <Text style={[type.body, { color: t.text, flex: 1 }]}>{label}</Text>
      <Text style={[type.body, TABULAR, { color: valueColor ?? t.textMuted }]}>{value}</Text>
      {onPress ? <Ionicons name="chevron-forward" size={15} color={t.textMuted} /> : null}
    </Pressable>
  );
}

export default function Home() {
  const t = useTheme();
  const app = useApp();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [todayShift, setTodayShift] = useState<ResolvedShift | null>(null);
  const [weekShifts, setWeekShifts] = useState<ResolvedShift[]>([]);
  const [recent, setRecent] = useState<ResolvedShift[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [temps, setTemps] = useState<Map<string, ReturnType<typeof taeumTemperature>>>(new Map());
  const [needsModel, setNeedsModel] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);

  const load = useCallback(async () => {
    const today = toDateString(Date.now());
    const entries = await listDutyEntries();
    const shifts = resolveAll(createSchedule(entries));
    setTodayShift(shifts.find((s) => s.date === today) ?? null);

    const weekStart = Date.now() - 3 * 24 * 3600_000;
    const weekEnd = Date.now() + 4 * 24 * 3600_000;
    setWeekShifts(shifts.filter((s) => s.startAt >= weekStart && s.startAt <= weekEnd));
    setRecent(shifts.filter((s) => s.startAt <= Date.now()).slice(-6).reverse());

    setDueCount(dueStates(await listReviewStates(), Date.now(), 9999).length);
    setPendingCount((await pendingTranscriptions()).length);
    const scores = await listTaeumScores(30);
    const map = new Map<string, ReturnType<typeof taeumTemperature>>();
    for (const sc of scores) {
      const date = sc.shiftId.split(":")[0];
      if (!map.has(date)) map.set(date, taeumTemperature(sc.score));
    }
    setTemps(map);
    setNeedsModel((await listModels()).every((m) => !m.installed));
  }, []);

  useEffect(() => {
    void checkForUpdate().then(setUpdate);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([app.refresh(), load()]);
    setRefreshing(false);
  }, [app, load]);

  const stats = laborStats(weekShifts);
  const warnings = laborWarnings(weekShifts, stats);
  const now = new Date();
  const today = toDateString(Date.now());
  const quote = dailyQuote(today);
  const latestTemp = recent.map((s) => temps.get(s.date)).find(Boolean) ?? null;
  const shiftDone = todayShift ? Date.now() > todayShift.endAt : false;
  const overtimeToday = todayShift
    ? Math.round(
        ((todayShift.onSiteEndAt - todayShift.onSiteStartAt) -
          (todayShift.endAt - todayShift.startAt)) / 360000,
      ) / 10
    : 0;

  const toneColor = { ok: t.ok, muted: t.textMuted, warn: t.warn, danger: t.danger } as const;
  const codeColor = (code: string): string =>
    code === "D" ? t.ok : code === "E" ? t.warn : code === "N" ? t.night : t.accent;

  return (
    <HeaderScreen
      title={greeting(now.getHours(), todayShift?.code)}
      subtitle={`${koreanDate(now)}${todayShift ? ` · ${todayShift.label} 근무` : " · 근무 없음"}`}
      right={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={app.recording ? "녹음 정지" : "녹음 시작"}
          onPress={async () => {
            if (app.recording) await stopManual();
            else await startManual(`${today}:MANUAL`);
            await app.refresh();
          }}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: app.recording ? t.recording : "rgba(255,255,255,0.14)",
          }}
        >
          <Ionicons name={app.recording ? "stop" : "mic-outline"} size={20} color={t.headerText} />
        </Pressable>
      }
      rows={[
        { label: "이번 주 근무", value: `${stats.onSiteHours}시간` },
        {
          label: "근무표 밖 · 주 40시간 초과",
          value: `${stats.offTheBooksHours} · ${stats.overtimeHours}시간`,
          tone: stats.offTheBooksHours + stats.overtimeHours > 0 ? "alert" : "default",
        },
      ]}
      banner={
        /* 색면 위 브리핑 체크리스트 — 모든 것이 이 한 장에 */
        <FolderCard tab={shiftDone ? "근무 후 브리핑" : "오늘의 브리핑"} tone="accent">
          <BriefRow
            icon="calendar-clear-outline"
            label={todayShift ? `${todayShift.label} ${formatClock(todayShift.startAt)}~${formatClock(todayShift.endAt)}` : "오늘 근무 없음"}
            value={todayShift ? `체류 ${formatClock(todayShift.onSiteStartAt)}~` : "듀티표"}
            onPress={() =>
              todayShift
                ? router.push(`/shift/${encodeURIComponent(todayShift.id)}`)
                : router.push("/duty")
            }
          />
          <DashedDivider />
          <BriefRow
            icon="time-outline"
            label="오늘의 오버타임"
            value={todayShift ? (overtimeToday > 0 ? `+${overtimeToday}시간` : "없음") : "—"}
            valueColor={overtimeToday > 0 ? t.warn : undefined}
          />
          <DashedDivider />
          <BriefRow
            icon="flame-outline"
            label="불타는 지수"
            value={latestTemp ? `${latestTemp.celsius}°C ${latestTemp.label}` : "기록 없음"}
            valueColor={latestTemp ? toneColor[latestTemp.tone] : undefined}
            onPress={() => router.push("/care")}
          />
          <DashedDivider />
          <BriefRow
            icon="document-text-outline"
            label="전사할 녹음"
            value={pendingCount > 0 ? `${pendingCount}건` : "없음"}
            valueColor={pendingCount > 0 ? t.warn : undefined}
            onPress={() =>
              todayShift ? router.push(`/shift/${encodeURIComponent(todayShift.id)}`) : router.push("/study")
            }
          />
          <DashedDivider />
          <BriefRow
            icon="school-outline"
            label="복습할 카드"
            value={dueCount > 0 ? `${dueCount}장` : "없음"}
            valueColor={dueCount > 0 ? t.accent : undefined}
            onPress={() => router.push("/study")}
          />
          {needsModel ? (
            <>
              <DashedDivider />
              <BriefRow
                icon="cloud-download-outline"
                label="전사 모델 설치 필요"
                value="받으러 가기"
                valueColor={t.warn}
                onPress={() => router.push("/models")}
              />
            </>
          ) : null}
          {update?.show ? (
            <>
              <DashedDivider />
              <BriefRow
                icon="sparkles-outline"
                label={`새 버전 ${update.version ?? ""}`}
                value="설정에서 받기"
                valueColor={t.accent}
                onPress={() => router.push("/settings")}
              />
            </>
          ) : null}
        </FolderCard>
      }
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* 오늘의 한 줄 */}
      <Card tone="accent">
        <Text style={{ fontSize: 26, lineHeight: 26, color: t.accent, fontWeight: "800" }}>&ldquo;</Text>
        <Body>{quote.text}</Body>
        {quote.by ? <Small>— {quote.by}</Small> : null}
      </Card>

      {/* 근로 경고 — 뜨면 그때가 봐야 할 때 */}
      {warnings.length > 0 ? (
        <FolderCard tab="근로 경고" tone="warn">
          {warnings.map((w, i) => (
            <View key={w.kind} style={{ gap: space.xxs }}>
              {i > 0 ? <DashedDivider /> : null}
              <Small muted={false}>{w.message}</Small>
              {w.reference ? <Small>{w.reference}</Small> : null}
            </View>
          ))}
        </FolderCard>
      ) : null}

      {/* 최근 근무 — 가로 타일 */}
      {recent.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Text style={[type.heading, { color: t.text }]}>최근 근무</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {recent.map((s) => {
              const temp = temps.get(s.date);
              return (
                <Pressable
                  key={s.id}
                  accessibilityRole="button"
                  onPress={() => router.push(`/shift/${encodeURIComponent(s.id)}`)}
                  style={{
                    width: 108,
                    backgroundColor: t.surface,
                    borderRadius: radius.lg,
                    padding: space.md,
                    gap: space.tight,
                  }}
                >
                  <Text style={[type.caption, TABULAR, { color: t.textMuted }]}>
                    {Number(s.date.slice(5, 7))}.{s.date.slice(8, 10)}
                  </Text>
                  <View
                    style={{
                      alignSelf: "flex-start",
                      backgroundColor: codeColor(s.code),
                      borderRadius: 4,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                    }}
                  >
                    <Text style={{ fontSize: 11, lineHeight: 15, color: "#FFF", fontWeight: "700" }}>
                      {s.label}
                    </Text>
                  </View>
                  <Text style={[type.small, TABULAR, { color: temp ? toneColor[temp.tone] : t.textMuted }]}>
                    {temp ? `${temp.celsius}°C` : "기록 없음"}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* 바로가기 칩 */}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {[
          { label: "병동 사전", to: "/ward-dict" },
          { label: "용어 검색", to: "/glossary" },
          { label: "전사 모델", to: "/models" },
        ].map((c) => (
          <Pressable
            key={c.label}
            accessibilityRole="button"
            onPress={() => router.push(c.to as never)}
            style={{
              flex: 1,
              minHeight: TOUCH_MIN,
              backgroundColor: t.surface,
              borderRadius: radius.full,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={[type.small, { color: t.text, fontWeight: "600" }]}>{c.label}</Text>
          </Pressable>
        ))}
      </View>
    </HeaderScreen>
  );
}
