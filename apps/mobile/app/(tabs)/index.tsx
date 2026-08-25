import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  createSchedule,
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
  Button,
  Card,
  DashedDivider,
  FolderCard,
  Heading,
  Row,
  Small,
  HeaderScreen,
} from "../../src/components/ui";
import { useApp } from "../../src/state/AppContext";
import { space, useTheme } from "../../src/theme";
import {
  listDutyEntries,
  listReviewStates,
  listTaeumScores,
  pendingTranscriptions,
} from "../../src/db";
import { startManual, stopManual } from "../../src/services/scheduler";
import { checkForUpdate, type UpdateCheck } from "../../src/services/update";

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 브리핑 머리말. 시각과 오늘 근무에 맞는 인사 —
 * 나이트 출근 전의 22시에 "좋은 아침"이라고 말하는 앱은 신뢰를 잃는다.
 */
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

export default function Home() {
  const t = useTheme();
  const app = useApp();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [todayShift, setTodayShift] = useState<ResolvedShift | null>(null);
  const [weekShifts, setWeekShifts] = useState<ResolvedShift[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [latestTemp, setLatestTemp] = useState<ReturnType<typeof taeumTemperature> | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);

  const load = useCallback(async () => {
    const today = toDateString(Date.now());
    const entries = await listDutyEntries();
    const shifts = resolveAll(createSchedule(entries));
    setTodayShift(shifts.find((s) => s.date === today) ?? null);

    const weekStart = Date.now() - 3 * 24 * 3600_000;
    const weekEnd = Date.now() + 4 * 24 * 3600_000;
    setWeekShifts(shifts.filter((s) => s.startAt >= weekStart && s.startAt <= weekEnd));

    setDueCount(dueStates(await listReviewStates(), Date.now(), 9999).length);
    setPendingCount((await pendingTranscriptions()).length);
    const scores = await listTaeumScores(1);
    setLatestTemp(scores.length > 0 ? taeumTemperature(scores[0].score) : null);
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

  // 오늘의 오버타임 — 근무표 시간과 실제 체류 예상의 차이.
  const overtimeToday = todayShift
    ? Math.round(
        ((todayShift.onSiteEndAt - todayShift.onSiteStartAt) -
          (todayShift.endAt - todayShift.startAt)) / 360000,
      ) / 10
    : 0;
  // 근무가 끝난 뒤인가 — 브리핑의 초점이 "끝나고 복기"로 바뀌는 시점.
  const shiftDone = todayShift ? Date.now() > todayShift.endAt : false;

  const toneColor = { ok: t.ok, muted: t.textMuted, warn: t.warn, danger: t.danger } as const;

  return (
    <HeaderScreen
      title={greeting(now.getHours(), todayShift?.code)}
      subtitle={`${koreanDate(now)}${todayShift ? ` · ${todayShift.label} 근무` : " · 근무 없음"}`}
      heroLabel="오늘"
      hero={todayShift ? `${todayShift.label} ${formatClock(todayShift.startAt)}` : "오프"}
      right={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={app.recording ? "녹음 정지" : "녹음 시작"}
          onPress={async () => {
            if (app.recording) await stopManual();
            else await startManual(`${toDateString(Date.now())}:MANUAL`);
            await app.refresh();
          }}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: app.recording ? t.recording : "rgba(255,255,255,0.12)",
          }}
        >
          <Ionicons name={app.recording ? "stop" : "mic-outline"} size={20} color={t.headerText} />
        </Pressable>
      }
      rows={[
        { label: "이번 주 근무", value: `${stats.onSiteHours}시간` },
        {
          label: "주 40시간 초과",
          value: `${stats.overtimeHours}시간`,
          tone: stats.overtimeHours > 0 ? "alert" : "default",
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* 새 판 안내 — 조건부라 평소엔 없다 */}
      {update?.show ? (
        <Card tone="accent">
          <Heading>새 버전이 출시되었습니다</Heading>
          <Small muted={false}>{update.message}</Small>
          <Button label="설정에서 받기" onPress={() => router.push("/settings")} />
        </Card>
      ) : null}

      {/* ── 근무 후 브리핑 서류철 ── */}
      <FolderCard tab={shiftDone ? "근무 후 브리핑" : "오늘의 서류"} tone="accent">
        {todayShift ? (
          <>
            <Row
              label={`${todayShift.label} ${formatClock(todayShift.startAt)}~${formatClock(todayShift.endAt)}`}
              value={shiftDone ? "기록 열기" : `실제 체류 ${formatClock(todayShift.onSiteStartAt)}~`}
              onPress={() => router.push(`/shift/${encodeURIComponent(todayShift.id)}`)}
            />
            <DashedDivider />
          </>
        ) : null}

        {/* 오늘의 오버타임 */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Ionicons name="time-outline" size={18} color={t.textMuted} />
            <Body>오늘의 오버타임</Body>
          </View>
          <Body muted={overtimeToday <= 0}>
            {todayShift ? (overtimeToday > 0 ? `+${overtimeToday}시간` : "없음") : "—"}
          </Body>
        </View>
        <DashedDivider />

        {/* 불타는 지수 */}
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/care")}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 32 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Ionicons
              name="flame-outline"
              size={18}
              color={latestTemp ? toneColor[latestTemp.tone] : t.textMuted}
            />
            <Body>불타는 지수</Body>
          </View>
          <Body muted={!latestTemp}>
            {latestTemp ? `${latestTemp.celsius}°C ${latestTemp.label}` : "기록 없음"}
          </Body>
        </Pressable>
        <DashedDivider />

        {/* 전사·복습 — 근무가 끝난 뒤 해야 할 일 */}
        {pendingCount > 0 ? (
          <>
            <Row
              label="전사할 녹음"
              value={`${pendingCount}건`}
              onPress={() =>
                todayShift
                  ? router.push(`/shift/${encodeURIComponent(todayShift.id)}`)
                  : router.push("/study")
              }
            />
            <DashedDivider />
          </>
        ) : null}
        <Row
          label="복습할 카드"
          value={dueCount > 0 ? `${dueCount}장` : "없음"}
          onPress={() => router.push("/study")}
        />
      </FolderCard>

      {/* 근로 경고 — 평소엔 안 보인다. 뜨면 그때가 봐야 할 때다. */}
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

      {/* 빠른 이동 */}
      <Card>
        <Row label="병동 사전" value="우리 병동 말" onPress={() => router.push("/ward-dict")} />
      </Card>
    </HeaderScreen>
  );
}
