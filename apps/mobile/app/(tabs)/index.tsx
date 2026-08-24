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

function levelTone(level: string): "ok" | "warn" | "danger" | "muted" {
  if (level === "severe") return "danger";
  if (level === "caution") return "warn";
  if (level === "watch") return "muted";
  return "ok";
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
  const [recentScores, setRecentScores] = useState<
    { shiftId: string; score: number; level: string }[]
  >([]);
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
    setRecentScores((await listTaeumScores(5)).map((s) => ({
      shiftId: s.shiftId,
      score: s.score,
      level: s.level,
    })));
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

  return (
    <HeaderScreen
      title="오늘"
      heroLabel="이번 주 근무"
      hero={`${stats.onSiteHours}시간`}
      rows={[
        { label: "야간", value: `${stats.nightHours}시간` },
        {
          label: "초과",
          value: `${stats.overtimeHours}시간`,
          tone: stats.overtimeHours > 0 ? "alert" : "default",
        },
        { label: "연속 근무", value: `${stats.longestConsecutiveDays}일` },
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

        {/* 오늘 근무 */}
        <Card>
          <Heading>오늘 근무</Heading>
          {todayShift ? (
            <>
              <Body>
                {todayShift.label} · {formatClock(todayShift.startAt)}~
                {formatClock(todayShift.endAt)}
              </Body>
              <Small>
                인계 포함 실제 체류 예상 {formatClock(todayShift.onSiteStartAt)}~
                {formatClock(todayShift.onSiteEndAt)}
              </Small>
              <Button
                label="이 근무 기록 보기"
                onPress={() => router.push(`/shift/${encodeURIComponent(todayShift.id)}`)}
              />
            </>
          ) : (
            <>
              <Body muted>오늘은 근무가 없거나 아직 입력하지 않았습니다.</Body>
              <Button label="듀티표 입력" onPress={() => router.push("/duty")} />
            </>
          )}
        </Card>

        {/* 학습 */}
        <Card>
          <Heading>복습</Heading>
          {totalCards === 0 ? (
            <Body muted>
              아직 카드가 없습니다. 근무를 녹음하고 전사하면 그날 나온 말로 카드가 만들어집니다.
            </Body>
          ) : (
            <Body>
              오늘 볼 카드 {dueCount}장 · 전체 {totalCards}장
            </Body>
          )}
          <Button
            label={dueCount > 0 ? `${dueCount}장 복습하기` : "카드 보기"}
            tone={dueCount > 0 ? "primary" : "default"}
            onPress={() => router.push("/study")}
          />
        </Card>

        {/* 근무 지표 */}
        {weekShifts.length > 0 ? (
          <Card>
            <Heading>이번 주 근무</Heading>
            <Row label="근무표상 근무시간" value={`${stats.scheduledHours}시간`} />
            <Divider />
            <Row
              label="인계 포함 실제 체류"
              value={`${stats.onSiteHours}시간`}
            />
            <Divider />
            <Row
              label="근무표에 없는 시간"
              value={`${stats.offTheBooksHours}시간`}
            />
            <Small>
              인계가 길어져 남은 시간입니다. 수당으로 안 잡히면 공짜로 일한 시간이 됩니다.
            </Small>
            <Divider />
            <Row label="주 40시간 초과" value={`${stats.overtimeHours}시간`} />
            <Divider />
            <Row label="야간근로" value={`${stats.nightHours}시간 · ${stats.nightShiftCount}회`} />
            {warnings.length > 0 ? (
              <View style={{ gap: space.sm, marginTop: space.sm }}>
                {warnings.map((w) => (
                  <View key={w.kind} style={{ gap: 2 }}>
                    <Badge text="확인해볼 지점" tone="warn" />
                    <Small muted={false}>{w.message}</Small>
                    {w.reference ? <Small>{w.reference}</Small> : null}
                  </View>
                ))}
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* 최근 근무 환경 */}
        {recentScores.length > 0 ? (
          <Card>
            <Heading>최근 근무 환경 기록</Heading>
            {recentScores.map((s) => (
              <View key={s.shiftId}>
                <Row
                  label={s.shiftId.split(":")[0]}
                  value={`${s.score}점`}
                  onPress={() => router.push(`/shift/${encodeURIComponent(s.shiftId)}`)}
                />
                <Badge
                  text={
                    s.level === "severe"
                      ? "심각"
                      : s.level === "caution"
                        ? "주의"
                        : s.level === "watch"
                          ? "관찰"
                          : "특이사항 없음"
                  }
                  tone={levelTone(s.level)}
                />
                <Divider />
              </View>
            ))}
            <Small>
              점수보다 인용문을 보세요. 어조와 맥락은 텍스트에 남지 않습니다.
            </Small>
          </Card>
        ) : null}

        <Card>
          <Row label="듀티표" onPress={() => router.push("/duty")} value="입력·수정" />
          <Divider />
          <Row label="용어와 자료" onPress={() => router.push("/glossary")} value="사전·공식 출처" />
          <Divider />
          <Row
            label="병동 사전"
            onPress={() => router.push("/ward-dict")}
            value="우리 병동 말·주고받기"
          />
          <Divider />
          <Row label="설정" onPress={() => router.push("/settings")} value="녹음·개인정보" />
        </Card>

        <Small>
          이 앱을 그만 쓰고 싶으면 설정에서 모든 녹음과 기록을 한 번에 지울 수 있습니다.
        </Small>
    </HeaderScreen>
  );
}
