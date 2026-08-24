import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Text } from "react-native";
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
  Badge,
  Body,
  Button,
  Card,
  Divider,
  Heading,
  Row,
  Small,
  HeaderScreen,
} from "../../src/components/ui";
import { useApp } from "../../src/state/AppContext";
import { space, type, useTheme } from "../../src/theme";
import {
  getSetting,
  listDutyEntries,
  listReviewStates,
  listTaeumScores,
} from "../../src/db";
import {
  SETTINGS_KEYS,
  platformCapability,
  startManual,
  stopManual,
} from "../../src/services/scheduler";
import { checkForUpdate, type UpdateCheck } from "../../src/services/update";
import { activeModelId, listModels } from "../../src/services/models";

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
  const [totalCards, setTotalCards] = useState(0);
  const [latestTemp, setLatestTemp] = useState<ReturnType<typeof taeumTemperature> | null>(null);
  const [iosContinuous, setIosContinuous] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  /** 모델을 하나도 안 받았으면 전사가 아예 안 된다. 처음 켠 사람이 제일 잘 막히는 곳. */
  const [needsModel, setNeedsModel] = useState(false);

  const load = useCallback(async () => {
    const today = toDateString(Date.now());
    const entries = await listDutyEntries();
    const schedule = createSchedule(entries);
    const shifts = resolveAll(schedule);
    setTodayShift(shifts.find((s) => s.date === today) ?? null);

    const weekStart = Date.now() - 3 * 24 * 3600_000;
    const weekEnd = Date.now() + 4 * 24 * 3600_000;
    setWeekShifts(shifts.filter((s) => s.startAt >= weekStart && s.startAt <= weekEnd));

    const states = await listReviewStates();
    setTotalCards(states.length);
    setDueCount(dueStates(states, Date.now(), 9999).length);
    const scores = await listTaeumScores(1);
    setLatestTemp(scores.length > 0 ? taeumTemperature(scores[0].score) : null);
    setIosContinuous(await getSetting<boolean>(SETTINGS_KEYS.iosContinuousSession, false));

    const models = await listModels();
    setNeedsModel(models.every((m) => !m.installed));
    void activeModelId();
  }, []);

  // 새 판 확인은 화면을 막지 않는다. 실패해도 조용히 넘어간다 —
  // 업데이트 확인 실패로 앱이 시끄러울 이유가 없다.
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
  const capability = platformCapability(iosContinuous);

  const now = new Date();
  return (
    <HeaderScreen
      title={greeting(now.getHours(), todayShift?.code)}
      subtitle={`${koreanDate(now)}${todayShift ? ` · ${todayShift.label} 근무` : " · 근무 없음"}`}
      heroLabel="오늘"
      hero={todayShift ? `${todayShift.label} ${formatClock(todayShift.startAt)}` : "오프"}
      rows={[
        { label: "이번 주 근무", value: `${stats.onSiteHours}시간` },
        {
          label: "근무표 밖",
          value: `${stats.offTheBooksHours}시간`,
          tone: stats.offTheBooksHours > 0 ? "alert" : "default",
        },
        {
          label: "주 40시간 초과",
          value: `${stats.overtimeHours}시간`,
          tone: stats.overtimeHours > 0 ? "alert" : "default",
        },
        ...(latestTemp
          ? [{
              label: "최근 근무 체온",
              value: `${latestTemp.celsius}°C ${latestTemp.label}`,
              tone: (latestTemp.tone === "warn" || latestTemp.tone === "danger"
                ? "alert"
                : "default") as "alert" | "default",
            }]
          : []),
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >

        {/* 알파 안내 — 처음 켠 사람이 무엇을 기대해야 하는지 */}
        {needsModel ? (
          <Card tone="warn">
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Badge text="설정 필요" tone="warn" />
              <Heading>전사 모델을 받아야 합니다</Heading>
            </View>
            <Body muted>
              녹음은 지금도 되지만, 모델이 없으면 글자로 옮기지 못합니다.
              Wi-Fi 에서 한 번만 받으면 됩니다.
            </Body>
            <Button
              label="모델 받으러 가기"
              tone="primary"
              onPress={() => router.push("/models")}
            />
          </Card>
        ) : null}

        {/* 새 판 */}
        {update?.show ? (
          <Card tone="accent">
            <Heading>새 판이 나왔습니다</Heading>
            <Small muted={false}>{update.message}</Small>
            {update.highlights.slice(0, 3).map((h, i) => (
              <Small key={i}>· {h}</Small>
            ))}
            <Button label="설정에서 받기" onPress={() => router.push("/settings")} />
          </Card>
        ) : null}

        {/* 녹음 상태 — 화면에서 가장 먼저 보여야 할 것 */}
        <Card tone={app.recording ? "accent" : "default"}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: app.recording ? t.recording : t.border,
              }}
            />
            <Heading>{app.recording ? "녹음 중" : "녹음 대기"}</Heading>
          </View>

          {app.currentWindow ? (
            <Small>
              {app.currentWindow.date} {app.currentWindow.label} ·{" "}
              {formatClock(app.currentWindow.startAt)}~{formatClock(app.currentWindow.endAt)}
            </Small>
          ) : app.nextWindow ? (
            <Small>
              다음 예정: {app.nextWindow.date} {app.nextWindow.label} ·{" "}
              {formatClock(app.nextWindow.startAt)} 시작
            </Small>
          ) : (
            <Small>
              {app.policy.enabled
                ? "예정된 근무가 없습니다. 듀티표를 입력해 주세요."
                : "자동 녹음이 꺼져 있습니다."}
            </Small>
          )}

          {!capability.fullyAutomatic ? (
            <Small>{capability.explanation}</Small>
          ) : null}

          <View style={{ flexDirection: "row", gap: space.sm }}>
            {app.recording ? (
              <View style={{ flex: 1 }}>
                <Button
                  label="녹음 정지"
                  tone="danger"
                  onPress={async () => {
                    await stopManual();
                    await app.refresh();
                  }}
                />
              </View>
            ) : (
              <View style={{ flex: 1 }}>
                <Button
                  label="지금 녹음 시작"
                  tone="primary"
                  onPress={async () => {
                    const shiftId = `${toDateString(Date.now())}:MANUAL`;
                    await startManual(shiftId);
                    await app.refresh();
                  }}
                />
              </View>
            )}
          </View>
        </Card>

        {/* 출근 전 브리핑 */}
        <Card>
          <Heading>출근 전 브리핑</Heading>
          {todayShift ? (
            <>
              <Row
                label={`${todayShift.label} ${formatClock(todayShift.startAt)}~${formatClock(todayShift.endAt)}`}
                value={`실제 체류 ${formatClock(todayShift.onSiteStartAt)}~`}
                onPress={() => router.push(`/shift/${encodeURIComponent(todayShift.id)}`)}
              />
              <Divider />
            </>
          ) : (
            <>
              <Row label="오늘 근무 없음" value="듀티표 입력" onPress={() => router.push("/duty")} />
              <Divider />
            </>
          )}
          <Row
            label="복습할 카드"
            value={dueCount > 0 ? `${dueCount}장` : "없음"}
            onPress={() => router.push("/study")}
          />
          {latestTemp ? (
            <>
              <Divider />
              <Row
                label="지난 근무 체온"
                value={`${latestTemp.celsius}°C ${latestTemp.label}`}
                onPress={() => router.push("/care")}
              />
            </>
          ) : null}
        </Card>

        {/* 빠른 이동. 듀티·마음·용어·설정은 아래 탭에 있으니 여기 두지 않는다. */}
        <Card>
          <Row
            label="병동 사전"
            value="우리 병동 말"
            onPress={() => router.push("/ward-dict")}
          />
        </Card>

        {/* 근로 경고 — 평소엔 안 보인다. 뜨면 그때가 봐야 할 때다. */}
        {warnings.length > 0 ? (
          <Card tone="warn">
            {warnings.map((w) => (
              <View key={w.kind} style={{ gap: space.xxs }}>
                <Small muted={false}>{w.message}</Small>
                {w.reference ? <Small>{w.reference}</Small> : null}
              </View>
            ))}
          </Card>
        ) : null}


    </HeaderScreen>
  );
}
