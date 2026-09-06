/**
 * 카드 암기 화면.
 *
 * 카드 세트에서 묶음 하나를 누르면 여기로 온다. 화면에는 카드 하나뿐이다 —
 * 외우는 동안 읽을 것이 카드 말고 또 있으면 눈이 그리로 간다.
 *
 *  · 누르면 뒤집힌다
 *  · 오른쪽으로 밀면 외웠다, 왼쪽으로 밀면 더 볼래
 *  · 왼쪽으로 넘긴 것은 이번 회차에 다시 나오고, 다 외우면 처음부터
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useNavigation } from "expo-router";
import {
  answerDrill,
  drillProgress,
  newCardState,
  resolveAll,
  review,
  shiftDueDateOffDuty,
  startDrill,
  type Card as StudyCard,
  type Drill,
  type ReviewState,
} from "@nsr/core";
import { Body, Card, Small } from "../../src/components/ui";
import { CONTENT_MAX, space, type, useTheme } from "../../src/theme";
import { Flashcard } from "../../src/components/flashcard";
import { buildSchedule } from "../../src/services/scheduler";
import { listCards, listDutyEntries, listReviewStates, saveReviewState } from "../../src/db";

/** 외웠다 4점, 더 볼래 1점. 미는 손은 두 갈래뿐이다. */
const KNOWN = 4 as const;
const AGAIN = 1 as const;

/** "2026-08-24:D" → "8월 24일 데이" */
function setTitle(shiftId: string): string {
  if (!shiftId || shiftId === "none") return "직접 만든 카드";
  const [date, code] = shiftId.split(":");
  const label =
    code === "D" ? "데이" : code === "E" ? "이브닝" : code === "N" ? "나이트" :
    code === "MANUAL" || code === "GEO" ? "수동 기록" : code;
  return `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 ${label}`;
}

export default function CardDrill() {
  const t = useTheme();
  const navigation = useNavigation();
  const { set } = useLocalSearchParams<{ set: string }>();
  const shiftId = set === "none" ? "" : (set ?? "");

  const [cards, setCards] = useState<StudyCard[]>([]);
  const [states, setStates] = useState<ReviewState[]>([]);
  const [nightDays, setNightDays] = useState<Set<number>>(new Set());
  const [drill, setDrill] = useState<Drill | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: setTitle(set ?? "") });
  }, [navigation, set]);

  useEffect(() => {
    void (async () => {
      const [all, allStates, duty] = await Promise.all([
        listCards(),
        listReviewStates(),
        listDutyEntries(),
      ]);
      const mine = all.filter((c) => (c.shiftId ?? "") === shiftId);
      setCards(mine);
      setStates(allStates);
      const nights = new Set<number>();
      for (const s of resolveAll(await buildSchedule(duty))) {
        if (s.code !== "N") continue;
        const d = new Date(s.startAt);
        d.setHours(0, 0, 0, 0);
        nights.add(d.getTime());
      }
      setNightDays(nights);
      setDrill(mine.length > 0 ? startDrill(mine.map((c) => c.id)) : null);
      setReady(true);
    })();
  }, [shiftId]);

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const stateById = useMemo(() => new Map(states.map((s) => [s.cardId, s])), [states]);
  const currentId = drill?.queue[0];
  const current = currentId ? cardById.get(currentId) : undefined;

  /**
   * 한 장에 답한다.
   *
   * 간격 반복 점수는 **한 묶음에서 카드마다 한 번만** 쓴다. 되풀이할 때마다 쓰면
   * srs 가 지키는 규칙(같은 세션 안에서 반복시키지 않는다)이 깨져서, 한 자리에서
   * 세 번 '더 볼래' 를 누른 것만으로 '계속 틀리는 카드' 가 된다.
   */
  const graded = useRef<Set<string>>(new Set());
  const answering = useRef(false);
  const answer = useCallback(
    async (known: boolean) => {
      if (!currentId || answering.current) return;
      answering.current = true;
      try {
        if (!graded.current.has(currentId)) {
          graded.current.add(currentId);
          const now = Date.now();
          const prev = stateById.get(currentId) ?? newCardState(currentId, now);
          const next = review(prev, known ? KNOWN : AGAIN, now);
          next.dueAt = shiftDueDateOffDuty(next.dueAt, (dayStart) => !nightDays.has(dayStart));
          await saveReviewState(next);
          setStates((prevStates) => [...prevStates.filter((s) => s.cardId !== currentId), next]);
        }
        setDrill((d) => (d ? answerDrill(d, known) : d));
      } finally {
        answering.current = false;
      }
    },
    [currentId, nightDays, stateById],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["bottom"]}>
      <View
        style={{
          flex: 1,
          padding: space.lg,
          gap: space.md,
          width: "100%",
          maxWidth: CONTENT_MAX,
          alignSelf: "center",
        }}
      >
        {!ready ? null : !current || !drill ? (
          <Card>
            <Body muted>이 묶음에는 카드가 없어요.</Body>
          </Card>
        ) : (
          <>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Small>{drill.round > 1 ? `${drill.round}회차` : "1회차"}</Small>
              <Text style={[type.small, { color: t.textMuted }]}>
                남은 {drill.queue.length} / {drill.all.length}
              </Text>
            </View>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: t.surfaceAlt }}>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: t.accent,
                  width: `${Math.round(drillProgress(drill) * 100)}%`,
                }}
              />
            </View>

            {/* 카드가 남는 자리를 다 쓴다. 화면에 다른 읽을 것을 두지 않는다 */}
            <View style={{ flex: 1, justifyContent: "center" }}>
              <Flashcard
                key={`${drill.round}:${currentId}`}
                front={current.front}
                back={current.back}
                hint={current.kind !== "cloze" ? (current.context ?? undefined) : undefined}
                onAnswer={(known) => void answer(known)}
              />
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
