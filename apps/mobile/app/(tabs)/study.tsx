import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
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
import { CONTENT_MAX, TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import { getNoteByTitle, getShiftReportMarkdown, saveNote } from "../../src/db";
import { buildSchedule } from "../../src/services/scheduler";
import {
  listCards,
  listDutyEntries,
  listReviewStates,
  listShiftReports,
  listTranscribedRecordings,
  saveReviewState,
  type ShiftReportRow,
  type TranscribedRecordingRow,
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

type Mode = "review" | "sets" | "reports" | "transcripts";

/** "2026-08-24:D" → "8월 24일 · 데이" */
function setTitle(shiftId: string | undefined): string {
  if (!shiftId) return "직접 만든 카드";
  const [date, code] = shiftId.split(":");
  const label =
    code === "D" ? "데이" : code === "E" ? "이브닝" : code === "N" ? "나이트" :
    code === "MANUAL" || code === "GEO" ? "수동 기록" : code;
  return `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 · ${label}`;
}

export default function Study() {
  const t = useTheme();
  const router = useRouter();
  // 첫 칩이 전사 기록이므로 처음 열리는 화면도 전사 기록이다 — 칩과 화면이 어긋나면 헷갈린다.
  const [mode, setMode] = useState<Mode>("transcripts");
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [states, setStates] = useState<ReviewState[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [nightDays, setNightDays] = useState<Set<number>>(new Set());
  const [done, setDone] = useState(0);
  const [reports, setReports] = useState<ShiftReportRow[]>([]);
  const [transcripts, setTranscripts] = useState<TranscribedRecordingRow[]>([]);
  const [search, setSearch] = useState("");
  const [openSet, setOpenSet] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [allCards, allStates, dutyEntries, allReports, allTranscripts] = await Promise.all([
      listCards(),
      listReviewStates(),
      listDutyEntries(),
      listShiftReports(),
      listTranscribedRecordings(),
    ]);
    setCards(allCards);
    setStates(allStates);
    setReports(allReports);
    setTranscripts(allTranscripts);

    // 나이트 근무일은 복습을 걸어봐야 못 한다. 그날은 예정일에서 비켜준다.
    const shifts = resolveAll(await buildSchedule(dutyEntries));
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

  // 화면에 돌아올 때마다 다시 읽는다 — 전사 기록을 지우고 돌아오면 목록이 낡아 있다.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

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
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.bottom,
          gap: space.md,
          width: "100%",
          maxWidth: CONTENT_MAX,
          alignSelf: "center",
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 머리 — 퀴즐렛처럼 제목이 크고 그 아래 칩이 있다 */}
        <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: "700", color: t.text }}>학습</Text>
        <ChipRow
          items={[
            { key: "transcripts", label: "전사 기록" },
            { key: "review", label: queue.length > 0 ? `복습 ${queue.length}` : "복습" },
            { key: "sets", label: "카드 세트" },
            { key: "reports", label: "근무 보고서" },
            { key: "notes", label: "노트" },
          ]}
          active={mode}
          onSelect={(k) => {
            // 노트는 자기 화면이 따로 있다 — 칩은 입구만 한다.
            if (k === "notes") {
              router.push("/notes");
              return;
            }
            setMode(k as Mode);
          }}
        />

        {/* ── 복습 ── */}
        {mode === "review" ? (
          cards.length === 0 ? (
            <Card>
              <Body muted>
                근무를 기록하고 전사하면 실제 들은 문장으로 암기 카드가 생성됩니다. 내일
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
        {/* ── 전사 기록 — 파일별로, 눌러서 결과 화면으로 ── */}
        {mode === "transcripts" ? (
          transcripts.length === 0 ? (
            <Card>
              <Body muted>
                전사가 끝난 기록이 아직 없습니다. 근무 기록에서 전사를 실행하면 여기 파일별로
                쌓입니다.
              </Body>
            </Card>
          ) : (
            transcripts.map((r) => {
              const started = new Date(r.started_at);
              const clock = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
              return (
                <Pressable
                  key={r.id}
                  accessibilityRole="button"
                  disabled={!r.shift_id}
                  onPress={() =>
                    r.shift_id && router.push(`/transcript/${encodeURIComponent(r.shift_id)}`)
                  }
                  style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.98 : 1 }] })}
                >
                  <Card>
                    <View
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: space.sm,
                      }}
                    >
                      <Text style={[type.cardTitle, { color: t.text, flexShrink: 1 }]}>
                        {setTitle(r.shift_id ?? undefined)}
                      </Text>
                      <Badge text={`${r.sentences}문장`} tone="muted" />
                    </View>
                    <Small>
                      {clock} 시작
                      {r.duration_sec > 0 ? ` · ${Math.round(r.duration_sec / 60)}분` : ""} · 눌러서
                      전사 확인·재생
                    </Small>
                  </Card>
                </Pressable>
              );
            })
          )
        ) : null}

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
                  {search ? "검색 결과가 없습니다." : "카드가 없습니다. 근무 전사 시 자동으로 만들어집니다."}
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
                
  보고서가 없습니다. 전사 후 ‘카드·보고서 만들기’를 실행하면 요약 보고서가 생성됩니다.
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
                    <Pressable
                      accessibilityRole="button"
                      onPress={async () => {
                        // 보고서를 편집 가능한 노트로 승격 — 같은 제목이 있으면 그 노트를 연다.
                        const md = await getShiftReportMarkdown(r.shiftId);
                        const title = `근무 보고서 ${r.shiftId.split(":")[0].replace(/-/g, ".")}`;
                        const existing = await getNoteByTitle(title);
                        const id = existing
                          ? existing.id
                          : await saveNote({ title, body: `#근무보고서\n\n${md ?? ""}` });
                        router.push(`/note/${id}`);
                      }}
                      style={({ pressed }) => ({
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        borderRadius: radius.full,
                        backgroundColor: t.surfaceAlt,
                        transform: [{ scale: pressed ? 0.95 : 1 }],
                      })}
                    >
                      <Text style={[type.small, { color: t.accent, fontWeight: "700" }]}>노트로</Text>
                    </Pressable>
                    <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
                  </View>
                </Pressable>
              );
            })
          )
        ) : null}

        {mode === "reports" ? (
          <Small>
            
  AI 보조 기능을 켜면 보고서에 근무 평가가 포함됩니다 (설정 › 보조 기능).
</Small>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
