/**
 * 카드 암기 화면.
 *
 * 카드 세트에서 묶음 하나를 누르면 여기로 온다. 화면에는 카드 하나뿐이다 —
 * 외우는 동안 읽을 것이 카드 말고 또 있으면 눈이 그리로 간다.
 *
 *  · 누르면 뒤집힌다
 *  · 오른쪽으로 밀면 외웠다, 왼쪽으로 밀면 더 볼래
 *  · 왼쪽으로 넘긴 것은 이번 회차에 다시 나오고, 다 외우면 처음부터
 *  · 한 장 넘길 때마다 자리를 적어 둔다 — 다른 화면에 갔다 오거나 앱이 꺼져도
 *    거기서 잇는다. 예전에는 화면에만 들고 있어서 나갔다 오면 처음부터였다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useNavigation } from "expo-router";
import {
  answerDrill,
  drillProgress,
  drillUnseen,
  newCardState,
  resolveAll,
  resumeDrill,
  review,
  shiftDueDateOffDuty,
  type Card as StudyCard,
  type Drill,
  type ReviewState,
} from "@nsr/core";
import { Body, Card } from "../../src/components/ui";
import { CONTENT_MAX, TABULAR, space, type, useTheme } from "../../src/theme";
import { Flashcard } from "../../src/components/flashcard";
import { buildSchedule } from "../../src/services/scheduler";
import {
  getSetting,
  listCards,
  listDutyEntries,
  listReviewStates,
  saveReviewState,
  setSetting,
} from "../../src/db";

/** 외웠다 4점, 더 볼래 1점. 미는 손은 두 갈래뿐이다. */
const KNOWN = 4 as const;
const AGAIN = 1 as const;

/** 이어 하기 자리. 묶음마다 하나. */
const drillKey = (set: string) => `cards.drill.${set || "none"}`;

/**
 * 한 자리(앉아서 외우는 한 번)로 보는 길이.
 *
 * 그 안에 이어 하면 이미 점수를 매긴 카드에 또 매기지 않는다 — 나갔다 오는 것만으로
 * '더 볼래' 가 두 번 적혀 계속 틀리는 카드가 되면 안 된다. 넘으면 새 자리라
 * 간격 반복 점수를 다시 쓴다. 근무 하나 길이로 잡았다.
 */
const SITTING_MS = 12 * 3600_000;

interface SavedDrill {
  drill: Drill;
  /** 이 자리에서 이미 점수를 매긴 카드. */
  graded: string[];
  at: number;
}

/** 진행 막대 한 줄 — 이름과 숫자, 그 아래 막대. */
function ProgressRow({
  label,
  value,
  fraction,
  color,
}: {
  label: string;
  value: string;
  fraction: number;
  color: string;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={[type.small, { color: t.textMuted, fontWeight: "600" }]}>{label}</Text>
        <Text style={[type.small, TABULAR, { color: t.textMuted, fontWeight: "600" }]}>{value}</Text>
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: t.surfaceAlt }}>
        <View
          style={{
            height: 4,
            borderRadius: 2,
            backgroundColor: color,
            width: `${Math.round(fraction * 100)}%`,
          }}
        />
      </View>
    </View>
  );
}

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
  /**
   * 간격 반복 점수는 **한 자리에서 카드마다 한 번만** 쓴다. 되풀이할 때마다 쓰면
   * srs 가 지키는 규칙(같은 세션 안에서 반복시키지 않는다)이 깨져서, 한 자리에서
   * 세 번 '더 볼래' 를 누른 것만으로 '계속 틀리는 카드' 가 된다.
   */
  const graded = useRef<Set<string>>(new Set());

  useEffect(() => {
    navigation.setOptions({ title: setTitle(set ?? "") });
  }, [navigation, set]);

  useEffect(() => {
    void (async () => {
      const [all, allStates, duty, saved] = await Promise.all([
        listCards(),
        listReviewStates(),
        listDutyEntries(),
        getSetting<SavedDrill | null>(drillKey(set ?? ""), null),
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
      if (saved && Date.now() - saved.at < SITTING_MS) graded.current = new Set(saved.graded);
      setDrill(mine.length > 0 ? resumeDrill(saved?.drill ?? null, mine.map((c) => c.id)) : null);
      setReady(true);
    })();
  }, [shiftId, set]);

  // 한 장 넘길 때마다 자리를 적는다. 화면을 떠날 때 적으려 하면 앱이 그냥 죽는
  // 길(안드로이드가 메모리를 거둘 때)에서 못 적는다.
  useEffect(() => {
    if (!ready || !drill) return;
    const saved: SavedDrill = { drill, graded: [...graded.current], at: Date.now() };
    void setSetting(drillKey(set ?? ""), saved);
  }, [drill, ready, set]);

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const stateById = useMemo(() => new Map(states.map((s) => [s.cardId, s])), [states]);
  const currentId = drill?.queue[0];
  const current = currentId ? cardById.get(currentId) : undefined;

  /** 한 장에 답한다. 점수는 위의 graded 가 한 자리에 한 번으로 막는다. */
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
            {/* 막대 둘. 위는 이번 회차를 어디까지 넘겼나(외웠든 아니든), 아래는 몇 장
                외웠나. 외운 것만 보여 주면 '더 볼래' 를 누를 때마다 막대가 제자리라
                회차의 어디쯤인지 알 수 없었다. 처음 보는 카드를 다 넘기면 위 숫자는
                다시 나올 카드 수로 바뀐다. */}
            <ProgressRow
              label={`${drill.round}회차`}
              value={
                drillUnseen(drill) > 0
                  ? `남은 ${drillUnseen(drill)}장`
                  : `다시 볼 카드 ${drill.queue.length}장`
              }
              fraction={(drill.all.length - drillUnseen(drill)) / drill.all.length}
              color={t.textMuted}
            />
            <ProgressRow
              label="외웠어요"
              value={`${drill.all.length - drill.queue.length} / ${drill.all.length}`}
              fraction={drillProgress(drill)}
              color={t.accent}
            />

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
