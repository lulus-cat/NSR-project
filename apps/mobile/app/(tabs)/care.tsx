import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
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
import { Body, Button, Card, Enter, Heading, Small } from "../../src/components/ui";
import { CONTENT_MAX, radius, space, type, useTheme } from "../../src/theme";
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
 * 채팅 — 학습과 마음 돌봄을 한 대화에서.
 *
 * 근무 체온(태움 지표)은 홈 서류철로 옮겼다. 이 화면은 대화가 전부다.
 * 최근 체온과 학습 자료는 화면에 그리지 않아도 대화 맥락에는 실린다.
 */

interface Msg extends ChatTurn {
  at: number;
}

const CHAT_SETTING = "care.chat";

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
  "오늘 태움 당했습니다.",
  "실수해서 자책 중입니다.",
  "그냥 지쳤어요",
  "오늘 근무 내용으로 퀴즈 내주십시오.",
  "최근 근무 보고서를 요약해 주십시오.",
];

const QUIZ_PROMPT = "암기카드와 최근 보고서로 퀴즈를 내주십시오. 답하면 확인해 주십시오.";

export default function Care() {
  const t = useTheme();
  const router = useRouter();
  const [latestTemp, setLatestTemp] = useState<ReturnType<typeof taeumTemperature> | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [studyCtx, setStudyCtx] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    // 체온 게이지는 홈에 있다. 여기서는 대화 맥락에 실을 최근 값만 본다.
    const scores = await listTaeumScores(1);
    setLatestTemp(scores[0] ? taeumTemperature(scores[0].score) : null);
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
            temp: latestTemp ? `${latestTemp.celsius}°C (${latestTemp.label})` : undefined,
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
    [busy, input, latestTemp, msgs],
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
            채팅
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
                    병동에서 있었던 일도, 오늘 배운 것도 좋습니다. 힘든 이야기는 들어주고,
                    공부 질문에는 선배처럼 답하고, 암기카드로 퀴즈도 냅니다. 대화는 이
                    화면에만 남습니다.
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
            placeholder={ready?.ok === false ? "설정에서 AI를 연결하면 시작합니다." : "무슨 일이 있었는지 적어 보십시오"}
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
