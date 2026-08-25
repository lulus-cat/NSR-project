import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
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
import { Badge, Body, Button, Card, Divider, Heading, HeaderScreen, Small } from "../../src/components/ui";
import { space, type, useTheme } from "../../src/theme";
import {
  listCards,
  listDutyEntries,
  listReviewStates,
  saveReviewState,
} from "../../src/db";
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

  const sources = current ? current.sourceIds.map(getSource).filter(Boolean) : [];

  // 갈래가 셋(빈 상태·복습 끝·복습 중)이어도 머리는 하나다.
  // 헤더의 대표 숫자는 "지금 남은 것" — 이 화면에 온 이유가 그것이다.
  return (
    <HeaderScreen
      title="학습"
      heroLabel="오늘 복습"
      hero={cards.length === 0 ? "카드 없음" : current ? `${queue.length}장` : "끝"}
      rows={[
        { label: "전체 카드", value: `${stats.total}장` },
        { label: "익숙해진 카드", value: `${stats.mature}장` },
        ...(stats.leeches > 0
          ? [{ label: "계속 틀리는 카드", value: `${stats.leeches}장`, tone: "alert" as const }]
          : []),
      ]}
    >
      {cards.length === 0 ? (
        <Card>
          <Heading>아직 카드가 없습니다</Heading>
          <Body muted>
            
  근무를 녹음하고 전사하면 실제 들은 문장으로 암기 카드가 생성됩니다. 내일 병동에서 바로 쓰이는 실전 용어가 정리됩니다.
</Body>
        </Card>
      ) : !current ? (
        <>
          <Card tone="accent">
            <Heading>오늘 복습 끝</Heading>
            <Body>{done > 0 ? `${done}장을 복습했습니다.` : "현재 복습할 카드가 없습니다."}</Body>
          </Card>
          {stats.leeches > 0 ? (
            <Card>
              <Badge text={`계속 틀리는 카드 ${stats.leeches}장`} tone="warn" />
              <Small>
                
  반복해 틀리는 용어는 기초 개념 정리 부족일 수 있습니다. 해당 용어의 공식 자료를 확인해 보십시오.
</Small>
            </Card>
          ) : null}
        </>
      ) : (
        <>
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
        </>
      )}
    </HeaderScreen>
  );
}
