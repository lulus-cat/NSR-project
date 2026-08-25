import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { taeumTemperature } from "@nsr/core";
import { Badge, Body, Button, Card, Enter, GaugeBar, Heading, Small } from "../../src/components/ui";
import { CONTENT_MAX, TABULAR, radius, space, type, useTheme } from "../../src/theme";
import {
  getSetting,
  getShiftReportMarkdown,
  listCards,
  listShiftReports,
  listTaeumScores,
  setSetting,
} from "../../src/db";
import { careChat, llmReady, type ChatTurn } from "../../src/services/llm";

/**
 * 마음 — 왼쪽엔 커다란 체온계, 그 아래는 상담 대화.
 *
 * 숫자 점수는 감각이 없다. 체온은 간호사의 직업 감각 그 자체다.
 * 그래서 태움 지수를 여기서는 처음부터 끝까지 체온으로만 말하고,
 * 수은주가 실제로 차오르는 걸 보여준다.
 */

interface TempRecord {
  shiftId: string;
  date: string;
  temp: ReturnType<typeof taeumTemperature>;
}

interface Msg extends ChatTurn {
  at: number;
}

const CHAT_SETTING = "care.chat";

/** 표시 눈금 범위. 35.5°가 바닥, 42°가 꼭대기 — 그 위는 가득 찬 채로 라벨이 말한다. */
const SCALE_MIN = 35.5;
const SCALE_MAX = 42;

/**
 * 수은 체온계 — 유리관·눈금·광택·그림자는 미리 그린 PNG 오버레이이고,
 * 앱은 그 아래에서 수은 기둥과 전구만 그려 색·높이를 움직인다.
 * View 로 유리를 흉내내던 이전 판보다 훨씬 실물답다.
 *
 * 좌표 계약 (생성기: scratchpad/gen-thermo.mjs 와 짝):
 *   기둥 left 40, width 20, bottom 45, height 16→145 (f=0→1)
 *   전구 중심 (50, 180), 지름 44
 *   눈금은 같은 식 h(f) = 16 + 129f 로 이미지에 박혀 있어 수은 꼭대기와 정확히 만난다.
 */
function Thermometer({
  celsius,
  color,
}: {
  celsius: number | null;
  color: string;
}) {
  const f =
    celsius === null
      ? 0
      : Math.min(1, Math.max(0, (celsius - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)));
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(v, {
      toValue: f,
      friction: 10,
      tension: 26,
      // height 애니메이션이라 JS 드라이버. 화면당 한 번 차오르는 것이 전부다.
      useNativeDriver: false,
    }).start();
  }, [v, f]);

  return (
    <View style={{ width: 110, height: 210 }}>
      {/* 수은 기둥 */}
      <Animated.View
        style={{
          position: "absolute",
          left: 40,
          width: 20,
          bottom: 45,
          height: v.interpolate({ inputRange: [0, 1], outputRange: [16, 145] }),
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
          backgroundColor: color,
        }}
      />
      {/* 수은 저장고 */}
      <View
        style={{
          position: "absolute",
          left: 28,
          top: 158,
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: color,
        }}
      />
      {/* 유리 오버레이 */}
      <Image
        source={require("../../assets/thermometer-glass.png")}
        style={{ position: "absolute", width: 110, height: 210 }}
      />
    </View>
  );
}

/** 답을 기다리는 동안 숨 쉬는 점 세 개. */
function TypingDots() {
  const t = useTheme();
  const vals = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];
  useEffect(() => {
    const loops = vals.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 360, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 360, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [vals]);
  return (
    <View style={{ flexDirection: "row", gap: 5, paddingVertical: 6, paddingHorizontal: 2 }}>
      {vals.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: t.textMuted,
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
            transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
          }}
        />
      ))}
    </View>
  );
}

/** 말풍선. 나타날 때 살짝 커지며 자리 잡는다. */
function Bubble({ msg }: { msg: Msg }) {
  const t = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(v, { toValue: 1, friction: 8, tension: 160, useNativeDriver: true }).start();
  }, [v]);
  const mine = msg.role === "user";
  return (
    <Animated.View
      style={{
        alignSelf: mine ? "flex-end" : "flex-start",
        maxWidth: "84%",
        opacity: v,
        transform: [
          { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
        ],
      }}
    >
      <View
        style={{
          backgroundColor: mine ? t.accent : t.surface,
          borderRadius: 18,
          borderBottomRightRadius: mine ? 6 : 18,
          borderBottomLeftRadius: mine ? 18 : 6,
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
        }}
      >
        <Text style={[type.body, { color: mine ? "#FFFFFF" : t.text }]}>{msg.text}</Text>
      </View>
    </Animated.View>
  );
}

const STARTERS = [
  "오늘 태움 당했어요",
  "실수해서 자책 중이에요",
  "그냥 지쳤어요",
  "오늘 근무 내용으로 퀴즈 내줘",
  "최근 보고서 요약해줘",
];

const QUIZ_PROMPT = "내 암기카드와 최근 근무 보고서로 퀴즈를 하나씩 내줘. 내가 답하면 맞았는지 확인해줘.";

export default function Care() {
  const t = useTheme();
  const router = useRouter();
  const [records, setRecords] = useState<TempRecord[]>([]);
  const [showRecords, setShowRecords] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [studyCtx, setStudyCtx] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    const scores = await listTaeumScores(30);
    setRecords(
      scores.map((s) => ({
        shiftId: s.shiftId,
        date: s.shiftId.split(":")[0],
        temp: taeumTemperature(s.score),
      })),
    );
    setMsgs(await getSetting<Msg[]>(CHAT_SETTING, []));
    setReady(await llmReady());

    // 학습 컨텍스트 — 최근 보고서 하나 + 암기카드 몇 장을 대화에 실어 둔다.
    // '퀴즈 내줘'가 자료 없이 헛돌지 않게 하는 밑재료다.
    let ctx = "";
    const reports = await listShiftReports(1);
    if (reports[0]) {
      const md = await getShiftReportMarkdown(reports[0].shiftId);
      if (md) ctx += `## 최근 근무 보고서 (${reports[0].shiftId.split(":")[0]})\n${md.slice(0, 2000)}\n`;
    }
    const cards = await listCards(12);
    if (cards.length > 0) {
      ctx += `\n## 암기카드\n${cards.map((c) => `- 앞: ${c.front} / 뒤: ${c.back}`).join("\n")}`;
    }
    setStudyCtx(ctx.trim() || null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = records[0] ?? null;
  const feverish = records.filter((r) => r.temp.tone === "danger" || r.temp.tone === "warn");
  const avg =
    records.length > 0
      ? Math.round((records.reduce((a, r) => a + r.temp.celsius, 0) / records.length) * 10) / 10
      : null;

  const toneColor = { ok: t.ok, muted: t.textMuted, warn: t.warn, danger: t.danger } as const;
  const mercury = latest ? toneColor[latest.temp.tone] : t.textMuted;

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || busy) return;
      const next: Msg[] = [...msgs, { role: "user", text, at: Date.now() }];
      setMsgs(next);
      setInput("");
      setBusy(true);
      setErr(null);
      try {
        const reply = await careChat(
          next.map((m) => ({ role: m.role, text: m.text })),
          {
            temp: latest ? `${latest.temp.celsius}°C (${latest.temp.label})` : undefined,
            study: studyCtx ?? undefined,
          },
        );
        const done: Msg[] = [...next, { role: "assistant", text: reply, at: Date.now() }];
        setMsgs(done);
        await setSetting(CHAT_SETTING, done.slice(-40));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "답을 받지 못했습니다. 다시 시도해 보십시오.");
        await setSetting(CHAT_SETTING, next.slice(-40));
      } finally {
        setBusy(false);
      }
    },
    [busy, input, latest, msgs],
  );

  const canSend = input.trim().length > 0 && !busy && (ready?.ok ?? false);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <KeyboardAvoidingView
        style={{ flex: 1, width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center" }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* 제목 줄 */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.sm,
          }}
        >
          <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: "700", color: t.text }}>
            마음 채팅
          </Text>
          <View style={{ flex: 1 }} />
          {ready?.ok && studyCtx ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void send(QUIZ_PROMPT)}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: space.sm })}
            >
              <Text style={[type.small, { color: t.accent, fontWeight: "700" }]}>카드 퀴즈</Text>
            </Pressable>
          ) : null}
          {msgs.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                Alert.alert("새 세션", "지금 대화를 지우고 새로 시작합니다.", [
                  { text: "취소", style: "cancel" },
                  {
                    text: "새로 시작",
                    style: "destructive",
                    onPress: async () => {
                      setMsgs([]);
                      setErr(null);
                      await setSetting(CHAT_SETTING, []);
                    },
                  },
                ]);
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: space.sm })}
            >
              <Text style={[type.small, { color: t.textMuted }]}>새 세션</Text>
            </Pressable>
          ) : null}
        </View>

        {/* 체온계 패널 */}
        <View style={{ paddingHorizontal: space.lg }}>
          <Enter index={0}>
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <Thermometer celsius={latest ? latest.temp.celsius : null} color={mercury} />
                <View style={{ flex: 1, gap: space.xs }}>
                  <Small>최근 근무 체온</Small>
                  <Text
                    style={[
                      TABULAR,
                      {
                        fontSize: 44,
                        lineHeight: 50,
                        fontWeight: "800",
                        color: latest ? mercury : t.textMuted,
                      },
                    ]}
                  >
                    {latest ? `${latest.temp.celsius.toFixed(1)}°` : "—"}
                  </Text>
                  {latest ? (
                    <Badge text={latest.temp.label} tone={latest.temp.tone} />
                  ) : (
                    <Small>근무를 기록하고 전사하면 온도가 올라옵니다.</Small>
                  )}
                  <Small>
                    {avg !== null ? `최근 30근무 평균 ${avg}°` : "아직 평균이 없습니다"}
                  </Small>
                  {feverish.length > 0 ? (
                    <Small muted={false}>열이 있었던 근무 {feverish.length}번</Small>
                  ) : null}
                  {records.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setShowRecords((s) => !s)}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Text style={[type.small, { color: t.accent, fontWeight: "700" }]}>
                        {showRecords ? "기록 접기" : `기록 ${records.length}개 보기`}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </Card>
          </Enter>

          {showRecords ? (
            <Enter index={0}>
              <Card style={{ marginTop: space.sm }}>
                {latest ? <Small muted={false}>{latest.temp.description}</Small> : null}
                {records.slice(0, 8).map((r) => (
                  <Pressable
                    key={r.shiftId}
                    accessibilityRole="button"
                    onPress={() => router.push(`/shift/${encodeURIComponent(r.shiftId)}`)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.md,
                      minHeight: 36,
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={[type.small, TABULAR, { color: t.text, width: 74 }]}>
                      {r.date.replace(/-/g, ".")}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <GaugeBar
                        ratio={(r.temp.celsius - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)}
                        color={toneColor[r.temp.tone]}
                      />
                    </View>
                    <Text
                      style={[
                        type.small,
                        TABULAR,
                        { color: toneColor[r.temp.tone], fontWeight: "700", width: 44, textAlign: "right" },
                      ]}
                    >
                      {r.temp.celsius.toFixed(1)}°
                    </Text>
                  </Pressable>
                ))}
                <Small>36.5° 정상 · 37.6° 발열 · 38.6° 고열 · 42°를 넘으면 측정 한계</Small>
              </Card>
            </Enter>
          ) : null}
        </View>

        {/* 대화 */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            padding: space.lg,
            gap: space.sm,
            flexGrow: 1,
            // 대화가 없을 때는 안내를 화면 가운데로 — 위에 붙어 있으면 아래가 휑하다.
            justifyContent: msgs.length === 0 && !busy ? "center" : "flex-start",
          }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          {msgs.length === 0 ? (
            <Enter index={1}>
              {ready && !ready.ok ? (
                <Card>
                  <Heading>이야기 상대를 연결해야 합니다</Heading>
                  <Body muted>{ready.reason}</Body>
                  <Button label="설정 열기" tone="primary" onPress={() => router.push("/settings")} />
                </Card>
              ) : (
                <Card>
                  <Heading>오늘 어땠습니까</Heading>
                  <Body muted>
                    병동에서 있었던 일, 서운했던 말, 무엇이든 좋습니다. 대화는 이 화면에만
                    남습니다.
                  </Body>
                  <Small>
                    메시지는 설정한 AI 공급자로 전송되며, 이름 같은 민감 정보는 자동으로 가리고
                    보냅니다.
                  </Small>
                  <Small>많이 위험하다고 느껴지면 지금 전화하십시오 — 1577-0199 · 109</Small>
                </Card>
              )}
            </Enter>
          ) : (
            msgs.map((m) => <Bubble key={m.at + m.role} msg={m} />)
          )}

          {msgs.length === 0 && (ready?.ok ?? false) ? (
            <Enter index={2}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {STARTERS.map((s) => (
                  <Pressable
                    key={s}
                    accessibilityRole="button"
                    onPress={() => void send(s)}
                    style={({ pressed }) => ({
                      backgroundColor: t.surface,
                      borderRadius: radius.full,
                      paddingHorizontal: space.lg,
                      paddingVertical: space.md,
                      transform: [{ scale: pressed ? 0.95 : 1 }],
                    })}
                  >
                    <Text style={[type.small, { color: t.text, fontWeight: "600" }]}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </Enter>
          ) : null}

          {busy ? (
            <View
              style={{
                alignSelf: "flex-start",
                backgroundColor: t.surface,
                borderRadius: 18,
                borderBottomLeftRadius: 6,
                paddingHorizontal: space.lg,
                paddingVertical: space.sm,
              }}
            >
              <TypingDots />
            </View>
          ) : null}
          {err ? <Small muted={false}>{err}</Small> : null}
        </ScrollView>

        {/* 입력줄 */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            gap: space.sm,
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
            backgroundColor: t.bg,
          }}
        >
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={ready?.ok === false ? "설정에서 AI 를 연결하면 시작됩니다" : "무슨 일이 있었는지 적어 보십시오"}
            placeholderTextColor={t.textMuted}
            editable={ready?.ok ?? false}
            multiline
            style={{
              flex: 1,
              color: t.text,
              backgroundColor: t.surfaceAlt,
              borderRadius: 22,
              paddingHorizontal: space.lg,
              paddingTop: 12,
              paddingBottom: 12,
              maxHeight: 110,
              fontSize: 15,
              lineHeight: 21,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="보내기"
            disabled={!canSend}
            onPress={() => void send()}
            style={({ pressed }) => ({
              width: 46,
              height: 46,
              borderRadius: 23,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: canSend ? t.accent : t.surfaceAlt,
              transform: [{ scale: pressed ? 0.9 : 1 }],
            })}
          >
            <Ionicons name="arrow-up" size={20} color={canSend ? "#FFFFFF" : t.textMuted} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
