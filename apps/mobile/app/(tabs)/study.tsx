import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
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
  type ShiftReport,
} from "@nsr/core";
import { Badge, Body, Button, Card, ChipRow, Divider, Small } from "../../src/components/ui";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  listCards,
  listDutyEntries,
  listReviewStates,
  listShiftReports,
  saveReviewState,
  type ShiftReportRow,
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

type Mode = "review" | "sets" | "reports";

/** "2026-08-24:D" → "8월 24일 · 데이" */
function setTitle(shiftId: string | undefined): string {
  if (!shiftId) return "근무 밖에서 만든 카드";
  const [date, code] = shiftId.split(":");
  const label =
    code === "D" ? "데이" : code === "E" ? "이브닝" : code === "N" ? "나이트" :
    code === "MANUAL" || code === "GEO" ? "수동 녹음" : code;
  return `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 · ${label}`;
}

export default function Study() {
  const t = useTheme();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("review");
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [states, setStates] = useState<ReviewState[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [nightDays, setNightDays] = useState<Set<number>>(new Set());
  const [done, setDone] = useState(0);
  const [reports, setReports] = useState<ShiftReportRow[]>([]);
  const [search, setSearch] = useState("");
  const [openSet, setOpenSet] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [allCards, allStates, dutyEntries, allReports] = await Promise.all([
      listCards(),
      listReviewStates(),
      listDutyEntries(),
      listShiftReports(),
    ]);
    setCards(allCards);
    setStates(allStates);
    setReports(allReports);

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

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const stateById = useMemo(() => new Map(states.map((s) => [s.cardId, s])), [states]);

  const currentId = queue[0];
  const current = currentId ? cardById.get(currentId) : undefined;
  const stats = studyStats(states, Date.now());

  const grade = useCallback(
    async (g: Grade) => {
      if (!currentId) return;
      const now = Date.now();
      const prev = stateById.get(currentId) ?? newCardState(currentId, now);
      const next = review(prev, g, now);
      next.dueAt = shiftDueDateOffDuty(next.dueAt, (dayStart) => !nightDays.has(dayStart));
      await saveReviewState(next);
      setStates((prevStates) => [...prevStates.filter((s) => s.cardId !== currentId), next]);
      setQueue((q) => q.slice(1));
      setRevealed(false);
      setDone((d) => d + 1);
    },
    [currentId, nightDays, stateById],
  );

  // ── 세트: 근무별로 묶는다 ──
  const sets = useMemo(() => {
    const q = search.trim();
    const filtered = q
      ? cards.filter((c) => c.front.includes(q) || c.back.includes(q))
      : cards;
    const bySet = new Map<string, StudyCard[]>();
    for (const c of filtered) {
      const key = c.shiftId ?? "";
      if (!bySet.has(key)) bySet.set(key, []);
      bySet.get(key)!.push(c);
    }
    return [...bySet.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [cards, search]);

  const sources = current ? current.sourceIds.map(getSource).filter(Boolean) : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.bottom, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 머리 — 퀴즐렛처럼 제목이 크고 그 아래 칩이 있다 */}
        <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: "700", color: t.text }}>학습</Text>
        <ChipRow
          items={[
            { key: "review", label: queue.length > 0 ? `복습 ${queue.length}` : "복습" },
            { key: "sets", label: "카드 세트" },
            { key: "reports", label: "근무 보고서" },
          ]}
          active={mode}
          onSelect={(k) => setMode(k as Mode)}
        />

        {/* ── 복습 ── */}
        {mode === "review" ? (
          cards.length === 0 ? (
            <Card>
              <Body muted>
                근무를 녹음하고 전사하면 실제 들은 문장으로 암기 카드가 생성됩니다. 내일
                병동에서 바로 쓰이는 실전 용어가 정리됩니다.
              </Body>
            </Card>
          ) : !current ? (
            <>
              <Card tone="accent">
                <Body>{done > 0 ? `오늘 ${done}장을 복습했습니다.` : "현재 복습할 카드가 없습니다."}</Body>
                <Small>
                  전체 {stats.total}장 · 익숙해진 카드 {stats.mature}장
                </Small>
              </Card>
              {stats.leeches > 0 ? (
                <Card>
                  <Badge text={`계속 틀리는 카드 ${stats.leeches}장`} tone="warn" />
                  <Small>
                    반복해 틀리는 용어는 기초 개념 정리 부족일 수 있습니다. 해당 용어의 공식
                    자료를 확인해 보십시오.
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
          )
        ) : null}

        {/* ── 카드 세트 (퀴즐렛 라이브러리) ── */}
        {mode === "sets" ? (
          <>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
                backgroundColor: t.surface,
                borderRadius: radius.lg,
                paddingHorizontal: space.md,
              }}
            >
              <Ionicons name="search" size={16} color={t.textMuted} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="용어 검색"
                placeholderTextColor={t.textMuted}
                style={{ flex: 1, color: t.text, minHeight: TOUCH_MIN, fontSize: 15 }}
              />
            </View>

            {sets.length === 0 ? (
              <Card>
                <Body muted>
                  {search ? "검색 결과가 없습니다." : "아직 카드가 없습니다. 근무를 전사하면 세트가 생깁니다."}
                </Body>
              </Card>
            ) : (
              sets.map(([shiftId, setCards]) => {
                const open = openSet === shiftId;
                return (
                  <View key={shiftId || "none"}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setOpenSet(open ? null : shiftId)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.md,
                        backgroundColor: t.surface,
                        borderRadius: radius.lg,
                        padding: space.lg,
                        minHeight: 64,
                      }}
                    >
                      <View
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: radius.md,
                          backgroundColor: t.accentSoft,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Ionicons name="albums-outline" size={20} color={t.accent} />
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[type.cardTitle, { color: t.text }]}>{setTitle(shiftId || undefined)}</Text>
                        <Text style={[type.small, { color: t.textMuted }]}>
                          낱말카드 {setCards.length}장
                        </Text>
                      </View>
                      <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={t.textMuted} />
                    </Pressable>

                    {open
                      ? setCards.map((c) => (
                          <View
                            key={c.id}
                            style={{
                              backgroundColor: t.surface,
                              borderRadius: radius.lg,
                              padding: space.lg,
                              marginTop: space.sm,
                              marginLeft: space.lg,
                              gap: space.tight,
                            }}
                          >
                            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
                              <Text style={[type.cardTitle, { color: t.text, flex: 1, fontWeight: "700" }]}>
                                {c.front}
                              </Text>
                              <Badge text={KIND_LABELS[c.kind]} tone="muted" />
                            </View>
                            <Text style={[type.small, { color: t.textMuted }]}>{c.back}</Text>
                          </View>
                        ))
                      : null}
                  </View>
                );
              })
            )}
          </>
        ) : null}

        {/* ── 근무 보고서 ── */}
        {mode === "reports" ? (
          reports.length === 0 ? (
            <Card>
              <Body muted>
                생성된 보고서가 없습니다. 근무 기록에서 전사를 마치고 &lsquo;카드·보고서
                만들기&rsquo;를 실행하면, 그 근무의 평가 — 새로 배운 용어, 잘한 점, 확인이
                필요한 점, 실수 언급 — 가 여기에 쌓입니다.
              </Body>
            </Card>
          ) : (
            reports.map((r) => {
              const p = (r.payload ?? {}) as Partial<ShiftReport>;
              return (
                <Pressable
                  key={r.shiftId}
                  accessibilityRole="button"
                  onPress={() => router.push(`/shift/${encodeURIComponent(r.shiftId)}`)}
                  style={{
                    backgroundColor: t.surface,
                    borderRadius: radius.lg,
                    padding: space.lg,
                    gap: space.sm,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: radius.md,
                        backgroundColor: t.accentSoft,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons name="document-text-outline" size={20} color={t.accent} />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={[type.cardTitle, { color: t.text }]}>
                        {setTitle(r.shiftId)} 보고서
                      </Text>
                      <Text style={[type.small, TABULAR, { color: t.textMuted }]}>
                        새 용어 {p.newTerms?.length ?? 0} · 확인 필요 {p.unresolved?.length ?? 0} ·
                        실수 언급 {p.mistakes?.length ?? 0}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
                  </View>
                </Pressable>
              );
            })
          )
        ) : null}

        {mode === "reports" ? (
          <Small>
            잘한 점·근무 평가는 보조 기능(AI)을 켜면 보고서에 함께 담깁니다. 설정 &gt; 보조
            기능에서 켤 수 있습니다.
          </Small>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
