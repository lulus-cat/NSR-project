import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps, ReactNode } from "react";
import {
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
  Badge,
  Body,
  Card,
  DashedDivider,
  Enter,
  HeaderScreen,
  Small,
} from "../../src/components/ui";
import { Thermometer } from "../../src/components/thermometer";
import { useApp } from "../../src/state/AppContext";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  getSetting,
  listDutyEntries,
  listReviewStates,
  listTaeumScores,
  pendingTranscriptions,
} from "../../src/db";
import { SETTINGS_KEYS, buildSchedule, startManual, stopManual } from "../../src/services/scheduler";
import { checkForUpdate, type UpdateCheck } from "../../src/services/update";
import { importAudioFile } from "../../src/services/import-audio";

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const GREETINGS = {
  dayMorning: [
    "바이탈보다 내 커피가 먼저입니다.",
    "오늘 첫 라운딩, 가볍게 다녀오십시오.",
    "차팅은 밀리기 전에, 커피는 식기 전에.",
    "좋은 아침입니다.",
  ],
  evening: [
    "이브닝의 저녁밥은 스테이션에서",
    "해 질 녘 출근하는 동료도 있습니다.",
    "이브닝 근무도 결국 끝이 납니다.",
  ],
  nightBefore: [
    "달이 뜨면 출근하는 사람",
    "나이트 근무의 밤은 길어도 아침은 옵니다.",
    "오늘 밤도 무사히",
  ],
  off: [
    "오늘 듀티: 아무것도 안 하기.",
    "오프는 근무의 일부입니다. 푹 쉬십시오",
    "알람 없는 아침, 그것이 오프",
  ],
  afterShift: [
    "고생하셨습니다. 오늘도 조용히 환자들을 구했습니다.",
    "퇴근하셨다면 병원 일은 다 잊으십시오.",
    "오늘 근무는 끝났습니다.",
  ],
  lateNight: ["고요한 밤입니다", "이 시간에 깨어 있는 동료들에게."],
} as const;

function pick(pool: readonly string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

function greeting(hour: number, dateSeed: string, shift?: ResolvedShift | null): string {
  const done = shift ? Date.now() > shift.endAt : false;
  if (shift?.code === "N" && hour >= 18) return pick(GREETINGS.nightBefore, dateSeed);
  if (shift && done) return pick(GREETINGS.afterShift, dateSeed);
  if (!shift && hour >= 7 && hour < 22) return pick(GREETINGS.off, dateSeed);
  if (shift?.code === "E") return pick(GREETINGS.evening, dateSeed);
  if (hour >= 5 && hour < 12) return pick(GREETINGS.dayMorning, dateSeed);
  if (hour >= 12 && hour < 22) return pick(GREETINGS.evening, dateSeed);
  return pick(GREETINGS.lateNight, dateSeed);
}

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function koreanDate(now: Date): string {
  return `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS_KO[now.getDay()]}요일`;
}

/** 기록 중일 때 마이크 버튼 뒤로 번지는 파동. 상태 표시라서 반복해도 시끄럽지 않다. */
function RecordPulse({ color }: { color: string }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, {
        toValue: 1,
        duration: 1400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        width: 44,
        height: 44,
        borderRadius: 22,
        borderWidth: 2,
        borderColor: color,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] }) }],
      }}
    />
  );
}

/** 브리핑 한 줄 — 아이콘·라벨·값·화살표. */
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
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 42,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={18} color={t.textMuted} />
      <Text style={[type.body, { color: t.text, flex: 1 }]}>{label}</Text>
      <Text style={[type.body, TABULAR, { color: valueColor ?? t.textMuted }]}>{value}</Text>
      {onPress ? <Ionicons name="chevron-forward" size={15} color={t.textMuted} /> : null}
    </Pressable>
  );
}

interface FolderSection {
  key: string;
  label: string;
  /** 주의가 필요한 폴더의 견출지에 붙는 점. 실제 상태가 있을 때만. */
  alert?: boolean;
  body: ReactNode;
}

/**
 * 서류철 — 가로로 겹쳐 꽂힌 견출지 탭들, 그 아래 펼쳐진 폴더 한 장.
 * (ShopBack 홈의 Online/Travel/Play 탭 구조. 세로로 쌓지 않는다.)
 * 탭을 누르면 그 폴더가 앞으로 뽑혀 나오고 내용이 아래에서 차오른다.
 */
function FolderStack({ sections }: { sections: FolderSection[] }) {
  const t = useTheme();
  const [active, setActive] = useState(sections[0]?.key ?? "");
  const anim = useRef(new Animated.Value(1)).current;

  const select = (key: string) => {
    if (key === active) return;
    setActive(key);
    anim.setValue(0);
    Animated.spring(anim, {
      toValue: 1,
      friction: 8,
      tension: 140,
      useNativeDriver: true,
    }).start();
  };

  const current = sections.find((s) => s.key === active) ?? sections[0];

  return (
    <View>
      {/* 견출지 줄. 겹침은 음수 마진, 앞뒤는 zIndex. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingLeft: 20,
          paddingRight: 28,
          alignItems: "flex-end",
        }}
      >
        {sections.map((s, i) => {
          const on = s.key === active;
          return (
            <Pressable
              key={s.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => select(s.key)}
              style={({ pressed }) => ({
                marginLeft: i === 0 ? 0 : -14,
                zIndex: on ? 30 : sections.length - i,
                height: on ? 42 : 34,
                paddingHorizontal: 16,
                paddingRight: 20,
                borderTopLeftRadius: 13,
                borderTopRightRadius: 13,
                backgroundColor: on ? t.surface : pressed ? t.surfaceRaised : t.surfaceAlt,
                justifyContent: "center",
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Text
                  style={[
                    type.caption,
                    { color: on ? t.text : t.textMuted, fontSize: on ? 13 : 12 },
                  ]}
                >
                  {s.label}
                </Text>
                {s.alert ? (
                  <View
                    style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.warn }}
                  />
                ) : null}
              </View>
              {on ? (
                <View
                  style={{
                    height: 3,
                    width: 16,
                    borderRadius: 2,
                    backgroundColor: t.accent,
                    marginTop: 3,
                  }}
                />
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      {/* 폴더 본문. 활성 탭과 같은 색이라 이음새 없이 붙는다. */}
      <View
        style={{
          backgroundColor: t.surface,
          borderRadius: 18,
          padding: space.lg,
          minHeight: 96,
        }}
      >
        <Animated.View
          style={{
            gap: space.md,
            opacity: anim,
            transform: [
              { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
            ],
          }}
        >
          {current?.body}
        </Animated.View>
      </View>
    </View>
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
  const [pendingShiftId, setPendingShiftId] = useState<string | null>(null);
  const [temps, setTemps] = useState<Map<string, ReturnType<typeof taeumTemperature>>>(new Map());
  const [needsServer, setNeedsServer] = useState(false);
  const [newResult, setNewResult] = useState<{ shiftId: string; sentences: number } | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [weekStrip, setWeekStrip] = useState<
    { date: string; day: number; code?: string; label?: string }[]
  >([]);

  const load = useCallback(async () => {
    const today = toDateString(Date.now());
    const entries = await listDutyEntries();
    const shifts = resolveAll(await buildSchedule(entries));
    setTodayShift(shifts.find((s) => s.date === today) ?? null);

    const weekStart = Date.now() - 3 * 24 * 3600_000;
    const weekEnd = Date.now() + 4 * 24 * 3600_000;
    setWeekShifts(shifts.filter((s) => s.startAt >= weekStart && s.startAt <= weekEnd));
    setRecent(shifts.filter((s) => s.startAt <= Date.now()).slice(-6).reverse());

    // 이번 주 스트립 — 일요일부터 7칸.
    const base = new Date();
    const sunday = new Date(base.getFullYear(), base.getMonth(), base.getDate() - base.getDay());
    setWeekStrip(
      Array.from({ length: 7 }, (_, i) => {
        const ds = toDateString(
          new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i).getTime(),
        );
        const s = shifts.find((x) => x.date === ds);
        return { date: ds, day: i, code: s?.code, label: s?.label };
      }),
    );

    setDueCount(dueStates(await listReviewStates(), Date.now(), 9999).length);
    const pending = await pendingTranscriptions();
    setPendingCount(pending.length);
    // 전사 실행 화면으로 가는 문 — 미전사 기록이 실제로 있는 근무를 가리킨다.
    setPendingShiftId(pending[0]?.shift_id ?? null);
    const scores = await listTaeumScores(30);
    const map = new Map<string, ReturnType<typeof taeumTemperature>>();
    for (const sc of scores) {
      const date = sc.shiftId.split(":")[0];
      if (!map.has(date)) map.set(date, taeumTemperature(sc.score));
    }
    setTemps(map);
    // 전사는 서버(콜랩·내 컴퓨터)가 한다. 주소가 없으면 연결부터 안내한다.
    const server = await getSetting<{ endpoint?: string }>(SETTINGS_KEYS.cloudTranscription, {});
    setNeedsServer(!server.endpoint);
    // 마지막 전사가 끝났는데 아직 결과를 안 열어봤으면 알려 준다.
    const last = await getSetting<{ shiftId?: string; sentences?: number; seen?: boolean }>(
      "transcribe.lastResult",
      {},
    );
    setNewResult(
      last.shiftId && !last.seen
        ? { shiftId: last.shiftId, sentences: last.sentences ?? 0 }
        : null,
    );
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
  const tempAvg =
    temps.size > 0
      ? Math.round(
          ([...temps.values()].reduce((a, v) => a + v.celsius, 0) / temps.size) * 10,
        ) / 10
      : null;
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

  const folders: FolderSection[] = [
    {
      key: "duty",
      label: "오늘 근무",
      body: todayShift ? (
        <>
          <BriefRow
            icon="calendar-clear-outline"
            label={`${todayShift.label} ${formatClock(todayShift.startAt)}~${formatClock(todayShift.endAt)}`}
            value={shiftDone ? "기록 열기" : `체류 ${formatClock(todayShift.onSiteStartAt)}~`}
            onPress={() => router.push(`/shift/${encodeURIComponent(todayShift.id)}`)}
          />
          <DashedDivider />
          <BriefRow
            icon="time-outline"
            label="오늘 인계 체류 (설정 기준 추정)"
            value={overtimeToday > 0 ? `+${overtimeToday}시간` : "없음"}
            valueColor={overtimeToday > 0 ? t.warn : undefined}
          />
        </>
      ) : (
        <BriefRow
          icon="calendar-clear-outline"
          label="오늘 근무 없음"
          value="듀티표"
          onPress={() => router.push("/duty")}
        />
      ),
    },
    {
      key: "overtime",
      label: "오버타임",
      alert: stats.offTheBooksHours + stats.overtimeHours > 0,
      body: (
        <>
          <BriefRow
            icon="albums-outline"
            label="이번 주 인계 체류 (추정)"
            value={`${stats.offTheBooksHours}시간`}
            valueColor={stats.offTheBooksHours > 0 ? t.warn : undefined}
          />
          <DashedDivider />
          <BriefRow
            icon="alert-circle-outline"
            label="주 40시간 초과"
            value={`${stats.overtimeHours}시간`}
            valueColor={stats.overtimeHours > 0 ? t.warn : undefined}
          />
          <DashedDivider />
          <BriefRow
            icon="time-outline"
            label="오늘"
            value={todayShift ? (overtimeToday > 0 ? `+${overtimeToday}시간` : "없음") : "—"}
            valueColor={overtimeToday > 0 ? t.warn : undefined}
          />
        </>
      ),
    },
    {
      key: "temp",
      label: "근무 체온",
      alert: latestTemp ? latestTemp.tone === "warn" || latestTemp.tone === "danger" : false,
      body: (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
          <Thermometer
            celsius={latestTemp?.celsius ?? null}
            color={latestTemp ? toneColor[latestTemp.tone] : t.textMuted}
          />
          <View style={{ flex: 1, gap: space.xs }}>
            <Small>최근 근무 체온</Small>
            <Text
              style={[
                TABULAR,
                {
                  fontSize: 40,
                  lineHeight: 46,
                  fontWeight: "800",
                  color: latestTemp ? toneColor[latestTemp.tone] : t.textMuted,
                },
              ]}
            >
              {latestTemp ? `${latestTemp.celsius.toFixed(1)}°` : "—"}
            </Text>
            {latestTemp ? (
              <Badge text={latestTemp.label} tone={latestTemp.tone} />
            ) : (
              <Small>근무를 전사하면 병동 분위기 온도를 보여줍니다.</Small>
            )}
            {tempAvg !== null ? (
              <Small>최근 {temps.size}근무 평균 {tempAvg}°</Small>
            ) : null}
          </View>
        </View>
      ),
    },
    {
      key: "records",
      label: "기록",
      alert: pendingCount > 0 || needsServer || newResult !== null,
      body: (
        <>
          {newResult ? (
            <>
              <BriefRow
                icon="checkmark-circle-outline"
                label="새 전사 결과가 나왔습니다."
                value={`${newResult.sentences}문장 · 보기`}
                valueColor={t.accent}
                onPress={() =>
                  router.push(`/transcript/${encodeURIComponent(newResult.shiftId)}`)
                }
              />
              <DashedDivider />
            </>
          ) : null}
          <BriefRow
            icon="document-text-outline"
            label="전사할 기록"
            value={pendingCount > 0 ? `${pendingCount}건 · 전사하기` : "없음"}
            valueColor={pendingCount > 0 ? t.warn : undefined}
            // 미전사 기록이 있는 근무로 바로 간다 — 거기 '전사하기' 버튼이 있다.
            // 기록이 없으면 눌리지 않는다: 예전엔 듀티표로 보내서, 전사하러
            // 들어온 사람이 영문 모를 화면에 떨어졌다.
            onPress={
              pendingShiftId
                ? () => router.push(`/shift/${encodeURIComponent(pendingShiftId)}`)
                : undefined
            }
          />
          {needsServer ? (
            <>
              <DashedDivider />
              <BriefRow
                icon="cloud-outline"
                label="전사 서버를 연결해 주십시오."
                value="연결"
                valueColor={t.warn}
                onPress={() => router.push("/models")}
              />
            </>
          ) : null}
          <DashedDivider />
          <BriefRow
            icon="folder-open-outline"
            label="다른 앱에서 음성 가져오기"
            value="선택"
            onPress={async () => {
              const r = await importAudioFile();
              if (r.ok && r.shiftId) {
                await load();
                router.push(`/shift/${encodeURIComponent(r.shiftId)}`);
              }
            }}
          />
        </>
      ),
    },
    {
      key: "cards",
      label: "카드",
      alert: dueCount > 0,
      body: (
        <BriefRow
          icon="school-outline"
          label="복습할 카드"
          value={dueCount > 0 ? `${dueCount}장` : "없음"}
          valueColor={dueCount > 0 ? t.accent : undefined}
          onPress={() => router.push("/study")}
        />
      ),
    },
  ];

  return (
    <HeaderScreen
      title={greeting(now.getHours(), today, todayShift)}
      subtitle={`${koreanDate(now)}${todayShift ? ` · ${todayShift.label} 근무` : " · 근무 없음"}`}
      right={
        <View style={{ alignItems: "center", justifyContent: "center" }}>
          {app.recording ? <RecordPulse color={t.recording} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={app.recording ? "기록 정지" : "기록 시작"}
            onPress={async () => {
              if (app.recording) await stopManual();
              else await startManual(`${today}:MANUAL`);
              await app.refresh();
            }}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              transform: [{ scale: pressed ? 0.92 : 1 }],
              backgroundColor: app.recording ? t.recording : "rgba(255,255,255,0.14)",
            })}
          >
            <Ionicons
              name={app.recording ? "stop" : "mic-outline"}
              size={20}
              color={t.headerText}
            />
          </Pressable>
        </View>
      }
      rows={[
        { label: "이번 주 근무", value: `${stats.onSiteHours}시간` },
        {
          label: "인계 체류 · 주 40시간 초과",
          value: `${stats.offTheBooksHours} · ${stats.overtimeHours}시간`,
          tone: stats.offTheBooksHours + stats.overtimeHours > 0 ? "alert" : "default",
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* ── 서류철: 견출지가 겹쳐 꽂힌 한 개의 서랍 ── */}
      <Enter index={0}>
        <FolderStack sections={folders} />
      </Enter>

      {/* 이번 주 — 일~토 한 줄 스트립 */}
      <Enter index={1}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/duty")}
          style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.98 : 1 }] })}
        >
          <Card>
            <View
              style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
            >
              <Text style={[type.heading, { color: t.text }]}>이번 주</Text>
              <Text style={[type.small, { color: t.textMuted }]}>듀티표 ›</Text>
            </View>
            <View style={{ flexDirection: "row" }}>
              {weekStrip.map((d, i) => {
                const isToday = d.date === today;
                const short: Record<string, string> = {
                  D: "D", E: "E", N: "N", OFF: "휴",
                  ADM: "상", SPC: "스", EDU: "교", ANNUAL: "연", SICK: "병", OTHER: "기",
                };
                return (
                  <View
                    key={d.date}
                    style={{
                      flex: 1,
                      alignItems: "center",
                      gap: 4,
                      paddingVertical: space.xs,
                      borderRadius: radius.md,
                      backgroundColor: isToday ? t.surfaceAlt : "transparent",
                    }}
                  >
                    <Text
                      style={[
                        type.caption,
                        { color: i === 0 ? t.danger : i === 6 ? t.night : t.textMuted },
                      ]}
                    >
                      {WEEKDAYS_KO[i]}
                    </Text>
                    <Text style={[type.small, TABULAR, { color: t.text, fontWeight: "600" }]}>
                      {Number(d.date.slice(-2))}
                    </Text>
                    {d.code && d.code !== "OFF" ? (
                      <View
                        style={{
                          minWidth: 22,
                          borderRadius: 5,
                          backgroundColor: codeColor(d.code),
                          paddingHorizontal: 4,
                          paddingVertical: 1,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 10,
                            lineHeight: 14,
                            color: "#FFF",
                            fontWeight: "700",
                            textAlign: "center",
                          }}
                        >
                          {short[d.code] ?? d.code}
                        </Text>
                      </View>
                    ) : (
                      <Text style={{ fontSize: 10, lineHeight: 16, color: t.textMuted }}>
                        {d.code === "OFF" ? "휴" : "·"}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          </Card>
        </Pressable>
      </Enter>

      {update?.show ? (
        <Enter index={1}>
          <Card tone="accent">
            <BriefRow
              icon="sparkles-outline"
              label={update.message}
              value="받기"
              valueColor={t.accent}
              onPress={() => router.push("/settings")}
            />
          </Card>
        </Enter>
      ) : null}

      {warnings.length > 0 ? (
        <Enter index={1}>
          <Card tone="warn">
            {warnings.map((w, i) => (
              <View key={w.kind} style={{ gap: space.xxs }}>
                {i > 0 ? <DashedDivider /> : null}
                <Small muted={false}>{w.message}</Small>
                {w.reference ? <Small>{w.reference}</Small> : null}
              </View>
            ))}
          </Card>
        </Enter>
      ) : null}

      {/* 오늘의 한 줄 */}
      <Enter index={2}>
        <Card tone="accent">
          <Text style={{ fontSize: 26, lineHeight: 26, color: t.accent, fontWeight: "800" }}>
            &ldquo;
          </Text>
          <Body>{quote.text}</Body>
          {quote.by ? <Small>— {quote.by}</Small> : null}
        </Card>
      </Enter>

      {/* 최근 근무 — 가로 타일 */}
      {recent.length > 0 ? (
        <Enter index={3}>
          <View style={{ gap: space.sm }}>
            <Text style={[type.heading, { color: t.text }]}>최근 근무</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: space.sm }}
            >
              {recent.map((s) => {
                const temp = temps.get(s.date);
                return (
                  <Pressable
                    key={s.id}
                    accessibilityRole="button"
                    onPress={() => router.push(`/shift/${encodeURIComponent(s.id)}`)}
                    style={({ pressed }) => ({
                      width: 108,
                      backgroundColor: t.surface,
                      borderRadius: radius.lg,
                      padding: space.md,
                      gap: space.tight,
                      transform: [{ scale: pressed ? 0.96 : 1 }],
                    })}
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
                      <Text
                        style={{ fontSize: 11, lineHeight: 15, color: "#FFF", fontWeight: "700" }}
                      >
                        {s.label}
                      </Text>
                    </View>
                    <Text
                      style={[
                        type.small,
                        TABULAR,
                        { color: temp ? toneColor[temp.tone] : t.textMuted },
                      ]}
                    >
                      {temp ? `${temp.celsius}°C` : "기록 없음"}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </Enter>
      ) : null}

      {/* 바로가기 칩 */}
      <Enter index={4}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {[
            { label: "병동 사전", to: "/ward-dict" },
            { label: "전사 설정", to: "/models" },
          ].map((c) => (
            <Pressable
              key={c.label}
              accessibilityRole="button"
              onPress={() => router.push(c.to as never)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: TOUCH_MIN,
                backgroundColor: t.surface,
                borderRadius: radius.full,
                alignItems: "center",
                justifyContent: "center",
                transform: [{ scale: pressed ? 0.96 : 1 }],
              })}
            >
              <Text style={[type.small, { color: t.text, fontWeight: "600" }]}>{c.label}</Text>
            </Pressable>
          ))}
        </View>
      </Enter>
    </HeaderScreen>
  );
}
