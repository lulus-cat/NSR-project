import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "react-native";
import {
  createSchedule,
  dueStates,
  newCardState,
  resolveAll,
  review,
  shiftDueDateOffDuty,
  studyStats,
  type Card as StudyCard,
  type Grade,
  type ReviewState,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { space, type, useTheme } from "../src/theme";
import {
  listCards,
  listDutyEntries,
  listReviewStates,
  saveReviewState,
} from "../src/db";
import { getSource } from "@nsr/core";

const KIND_LABELS: Record<StudyCard["kind"], string> = {
  definition: "뜻",
  cloze: "빈칸",
  pitfall: "주의점",
  formal: "기록 표현",
};

/** SM-2의 0~5를 사람이 고를 수 있는 4개로 줄인다. 6개는 너무 많다. */
const GRADES: { grade: Grade; label: string; hint: string }[] = [
  { grade: 1, label: "몰랐다", hint: "내일 다시" },
  { grade: 3, label: "겨우", hint: "곧 다시" },
  { grade: 4, label: "맞음", hint: "" },
  { grade: 5, label: "쉬움", hint: "한참 뒤" },
];

export default function Study() {
  const t = useTheme();
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [states, setStates] = useState<ReviewState[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [nightDays, setNightDays] = useState<Set<number>>(new Set());
  const [done, setDone] = useState(0);

  const load = useCallback(async () => {
    const [allCards, allStates, dutyEntries] = await Promise.all([
      listCards(),
      listReviewStates(),
      listDutyEntries(),
    ]);
    setCards(allCards);
    setStates(allStates);

    // 나이트 근무일은 복습을 걸어봐야 못 한다. 그날은 예정일에서 비켜준다.
    const shifts = resolveAll(createSchedule(dutyEntries));
    const nights = new Set<number>();
    for (const s of shifts) {
      if (s.code !== "N") continue;
      const d = new Date(s.startAt);
      d.setHours(0, 0, 0, 0);
      nights.add(d.getTime());
    }
    setNightDays(nights);

    const due = dueStates(allStates, Date.now(), 40);
    setQueue(due.map((s) => s.cardId));
    setRevealed(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cardById = useMemo(
    () => new Map(cards.map((c) => [c.id, c])),
    [cards],
  );
  const stateById = useMemo(
    () => new Map(states.map((s) => [s.cardId, s])),
    [states],
  );

  const currentId = queue[0];
  const current = currentId ? cardById.get(currentId) : undefined;
  const stats = studyStats(states, Date.now());

  const grade = useCallback(
    async (g: Grade) => {
      if (!currentId) return;
      const now = Date.now();
      const prev = stateById.get(currentId) ?? newCardState(currentId, now);
      const next = review(prev, g, now);
      // 나이트 근무일에 걸린 복습은 공부 가능한 날로 옮긴다.
      next.dueAt = shiftDueDateOffDuty(next.dueAt, (dayStart) => !nightDays.has(dayStart));
      await saveReviewState(next);
      setStates((prevStates) => [
        ...prevStates.filter((s) => s.cardId !== currentId),
        next,
      ]);
      setQueue((q) => q.slice(1));
      setRevealed(false);
      setDone((d) => d + 1);
    },
    [currentId, nightDays, stateById],
  );

  if (cards.length === 0) {
    return (
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Card>
          <Heading>아직 카드가 없습니다</Heading>
          <Body muted>
            근무를 녹음하고 전사하면 그날 실제로 들은 문장으로 카드가 만들어집니다.
            시중 암기장과 다른 점은, 여기 나오는 말이 내일도 그 병동에서 나온다는 것입니다.
          </Body>
        </Card>
      </ScrollView>
    );
  }

  if (!current) {
    return (
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Card tone="accent">
          <Heading>오늘 복습 끝</Heading>
          <Body>{done > 0 ? `${done}장 봤습니다.` : "지금 볼 카드가 없습니다."}</Body>
        </Card>
        <Card>
          <Heading>진행 상황</Heading>
          <Body>전체 {stats.total}장</Body>
          <Small>
            익숙해진 카드 {stats.mature}장 · 아직 배우는 중 {stats.learning}장
          </Small>
          {stats.leeches > 0 ? (
            <>
              <Divider />
              <Badge text={`계속 틀리는 카드 ${stats.leeches}장`} tone="warn" />
              <Small>
                반복해서 틀리는 카드는 대개 카드가 나쁜 게 아니라 그 앞의 개념이 비어 있다는 뜻입니다.
                해당 용어의 공식 자료를 한 번 읽어보는 편이 빠릅니다.
              </Small>
            </>
          ) : null}
        </Card>
      </ScrollView>
    );
  }

  const sources = current.sourceIds.map(getSource).filter(Boolean);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Badge text={KIND_LABELS[current.kind]} tone="muted" />
        <Small>남은 {queue.length}장</Small>
      </View>

      <Card>
        <Text style={[type.body, { color: t.text, fontSize: 18, lineHeight: 27 }]}>
          {current.front}
        </Text>
      </Card>

      {revealed ? (
        <>
          <Card tone="accent">
            <Text style={[type.body, { color: t.text }]}>{current.back}</Text>
          </Card>
          {current.context && current.kind !== "cloze" ? (
            <Card>
              <Small>그날 들은 문장</Small>
              <Body muted>&ldquo;{current.context}&rdquo;</Body>
            </Card>
          ) : null}
          {sources.length > 0 ? (
            <Card>
              <Small>더 볼 자료</Small>
              {sources.map((s) =>
                s ? (
                  <View key={s.id} style={{ gap: 2, paddingVertical: space.xs }}>
                    <Body>{s.name}</Body>
                    <Small>
                      {s.publisher} · {s.url}
                    </Small>
                  </View>
                ) : null,
              )}
            </Card>
          ) : null}
          <View style={{ gap: space.sm }}>
            {GRADES.map((g) => (
              <Button
                key={g.grade}
                label={g.hint ? `${g.label} · ${g.hint}` : g.label}
                tone={g.grade >= 4 ? "primary" : "default"}
                onPress={() => void grade(g.grade)}
              />
            ))}
          </View>
        </>
      ) : (
        <Button label="답 보기" tone="primary" onPress={() => setRevealed(true)} />
      )}
    </ScrollView>
  );
}
