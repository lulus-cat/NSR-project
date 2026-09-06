import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  answerDrill,
  drillProgress,
  dueStates,
  newCardState,
  resolveAll,
  review,
  shiftDueDateOffDuty,
  startDrill,
  studyStats,
  type Card as StudyCard,
  type Drill,
  type ReviewState,
  type ShiftReport,
} from "@nsr/core";
import { Badge, Body, Button, Card, ChipRow, Divider, Small } from "../../src/components/ui";
import { Flashcard } from "../../src/components/flashcard";
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

// 등급을 넷에서 둘로 줄였다. 카드를 미는 손은 "외웠다 / 더 볼래" 두 갈래뿐이고,
// 그 둘을 간격 반복의 등급으로 옮긴다 (외웠다 4점, 더 볼래 1점).
const GRADE_KNOWN = 4 as const;
const GRADE_AGAIN = 1 as const;

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
  /** 지금 돌리고 있는 묶음. 다 외우면 처음부터 다시 돈다. */
  const [drill, setDrill] = useState<Drill | null>(null);
  /** 어느 묶음을 돌리나 — "due" 는 오늘 볼 카드, 그 밖은 근무 번호. */
  const [deck, setDeck] = useState<string>("due");
  const [nightDays, setNightDays] = useState<Set<number>>(new Set());
  const [done, setDone] = useState(0);
  /** 오늘 볼 카드 (간격 반복이 고른 것). 묶음 하나로 쓴다. */
  const [dueIds, setDueIds] = useState<string[]>([]);
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

    setDueIds(dueStates(allStates, Date.now(), 200).map((st) => st.cardId));
  }, []);

  // 화면에 돌아올 때마다 다시 읽는다 — 전사 기록을 지우고 돌아오면 목록이 낡아 있다.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const stateById = useMemo(() => new Map(states.map((s) => [s.cardId, s])), [states]);

  const stats = studyStats(states, Date.now());

  // ── 날짜별 묶음 — 어느 날 근무에서 나온 카드인지로 나눈다 ──
  const decks = useMemo(() => {
    const byDate = new Map<string, string[]>();
    for (const c of cards) {
      const date = c.shiftId?.split(":")[0] ?? "직접";
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(c.id);
    }
    return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [cards]);

  const deckIds = useMemo(() => {
    if (deck === "due") return dueIds;
    if (deck === "all") return cards.map((c) => c.id);
    return decks.find(([d]) => d === deck)?.[1] ?? [];
  }, [cards, deck, decks, dueIds]);

  // 묶음이 바뀌면 처음부터. 길이가 아니라 **내용**으로 본다 — 오늘 볼 카드는 화면에
  // 들어올 때마다 다시 고르는데, 한 장이 들어오고 한 장이 빠지면 길이는 그대로다.
  // 그러면 없는 카드 번호를 든 채로 "이 묶음에는 카드가 없어요" 가 뜬다.
  const deckKey = deckIds.join(",");
  useEffect(() => {
    graded.current = new Set();
    setDrill(deckIds.length > 0 ? startDrill(deckIds) : null);
    // deckIds 는 deckKey 가 같으면 내용도 같다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckKey]);

  const currentId = drill?.queue[0];
  const current = currentId ? cardById.get(currentId) : undefined;

  /**
   * 한 장에 답한다.
   *
   * 눈앞의 되풀이(drill)와 며칠 뒤 다시 볼 날짜(간격 반복)를 **둘 다** 움직인다.
   * 앉은 자리에서 다 외웠다고 카드가 영영 사라지면 안 되고, 반대로 며칠 뒤 날짜만
   * 잡고 지금 안 보여 주면 지금 못 외운다.
   */
  /**
   * 한 장에 답한다.
   *
   * **간격 반복 점수는 한 묶음에서 카드마다 한 번만** 쓴다. 되풀이할 때마다 쓰면
   * srs.ts 가 지키는 규칙("실패한 카드는 다음 날 다시. 같은 세션 안에서 반복시키지
   * 않는다")이 깨진다 — 한 자리에서 세 번 '더 볼래' 를 누르면 lapses 가 3이 되고
   * easeFactor 가 바닥(1.3)까지 떨어져, 앉은 자리에서 '계속 틀리는 카드' 가 된다.
   * 반대쪽도 마찬가지다. 몇 분 만에 다음 복습이 15일 뒤로 밀린다.
   *
   * 그래서 **처음 답한 것**만 점수로 친다. 그게 정직한 신호다. 그 뒤의 되풀이는
   * 눈앞의 줄(drill)만 움직인다.
   */
  const graded = useRef<Set<string>>(new Set());
  const answering = useRef(false);
  const answer = useCallback(
    async (known: boolean) => {
      // 미는 손과 아래 버튼이 한 장에 두 번 답하지 못하게. 두 번 답하면 한 장이
      // 통째로 건너뛰어진다 — 안 보이고 다시 안 나온다.
      if (!currentId || answering.current) return;
      answering.current = true;
      try {
        if (!graded.current.has(currentId)) {
          graded.current.add(currentId);
          const now = Date.now();
          const prev = stateById.get(currentId) ?? newCardState(currentId, now);
          const next = review(prev, known ? GRADE_KNOWN : GRADE_AGAIN, now);
          next.dueAt = shiftDueDateOffDuty(next.dueAt, (dayStart) => !nightDays.has(dayStart));
          await saveReviewState(next);
          setStates((prevStates) => [...prevStates.filter((st) => st.cardId !== currentId), next]);
        }
        setDrill((d) => (d ? answerDrill(d, known) : d));
        if (known) setDone((v) => v + 1);
      } finally {
        answering.current = false;
      }
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

  // ── 전사 기록 줄 — 합친 파일들은 근무 하나로, '따로' 둔 파일은 제 줄로 ──
  const transcriptRows = useMemo(() => {
    type Row = {
      key: string;
      shiftId: string | null;
      /** 있으면 '따로' 둔 파일 하나. */
      recId?: string;
      label: string | null;
      startedAt: number;
      durationSec: number;
      sentences: number;
      files: number;
    };
    const merged = new Map<string, Row>();
    const rows: Row[] = [];
    for (const r of transcripts) {
      if (r.separate === 1 || !r.shift_id) {
        rows.push({
          key: r.id,
          shiftId: r.shift_id,
          recId: r.id,
          label: r.label,
          startedAt: r.started_at,
          durationSec: r.duration_sec,
          sentences: r.sentences,
          files: 1,
        });
        continue;
      }
      const g = merged.get(r.shift_id);
      if (g) {
        g.sentences += r.sentences;
        g.durationSec += r.duration_sec;
        g.files += 1;
        g.startedAt = Math.min(g.startedAt, r.started_at);
      } else {
        merged.set(r.shift_id, {
          key: `shift:${r.shift_id}`,
          shiftId: r.shift_id,
          label: null,
          startedAt: r.started_at,
          durationSec: r.duration_sec,
          sentences: r.sentences,
          files: 1,
        });
      }
    }
    return [...rows, ...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  }, [transcripts]);

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
            { key: "review", label: dueIds.length > 0 ? `암기 ${dueIds.length}` : "암기" },
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

        {/* ── 암기 ── */}
        {mode === "review" ? (
          cards.length === 0 ? (
            <Card>
              <Body muted>
                근무를 기록하고 글자로 바꾸면 실제 들은 문장으로 카드가 생겨요. 내일 병동에서
                바로 쓸 말이에요.
              </Body>
            </Card>
          ) : (
            <>
              {/* 어느 묶음을 돌릴까 — 오늘 볼 것, 전체, 그리고 날짜마다 하나씩 */}
              <ChipRow
                items={[
                  { key: "due", label: `오늘 ${dueIds.length}` },
                  { key: "all", label: `전체 ${cards.length}` },
                  ...decks.map(([date, ids]) => ({
                    key: date,
                    label:
                      date === "직접"
                        ? `직접 ${ids.length}`
                        : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${ids.length}`,
                  })),
                ]}
                active={deck}
                onSelect={setDeck}
              />

              {!current || !drill ? (
                <>
                  <Card tone="accent">
                    <Body>
                      {deck === "due" && dueIds.length === 0
                        ? "오늘 볼 카드가 없어요. 위에서 날짜를 골라 보세요."
                        : "이 묶음에는 카드가 없어요."}
                    </Body>
                    <Small>
                      전체 {stats.total}장 · 익숙해진 카드 {stats.mature}장
                    </Small>
                  </Card>
                  {stats.leeches > 0 ? (
                    <Card>
                      <Badge text={`계속 틀리는 카드 ${stats.leeches}장`} tone="warn" />
                      <Small>
                        자꾸 틀리는 말은 기초가 흔들린다는 뜻일 수 있어요. 그 말의 공식 자료를
                        한 번 찾아봐요.
                      </Small>
                    </Card>
                  ) : null}
                </>
              ) : (
                <>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Badge text={KIND_LABELS[current.kind]} tone="muted" />
                    <Small>
                      {drill.round > 1 ? `${drill.round}회차 · ` : ""}남은 {drill.queue.length}장
                    </Small>
                  </View>

                  {/* 이번 회차가 얼마나 남았나. 숫자보다 이 막대가 먼저 읽힌다 */}
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

                  {/* 회차와 카드 번호를 열쇠로 준다. 한 장짜리 묶음이나 앞뒤 글이 같은
                      카드가 이어지면, 다시 그릴 이유가 없어서 카드가 화면 밖에 나간
                      채로 남았다 — 진행 막대와 버튼만 있고 카드가 안 보였다. */}
                  <Flashcard
                    key={`${drill.round}:${currentId}`}
                    front={current.front}
                    back={current.back}
                    hint={current.kind !== "cloze" ? (current.context ?? undefined) : undefined}
                    onAnswer={(known) => void answer(known)}
                  />

                  <Small>누르면 뒤집혀요.</Small>
                  <Small>오른쪽으로 밀면 외웠어요.</Small>
                  {sources.length > 0 ? (
                    <Card>
                      <Small>더 볼 자료</Small>
                      {sources.map((src) =>
                        src ? (
                          <View key={src.id} style={{ gap: 2, paddingVertical: space.xs }}>
                            <Body>{src.name}</Body>
                            <Small>
                              {src.publisher} · {src.url}
                            </Small>
                          </View>
                        ) : null,
                      )}
                    </Card>
                  ) : null}
                  {/* 미는 것만으로는 못 쓰는 손이 있다. 같은 일을 하는 버튼을 함께 둔다 */}
                  <View style={{ flexDirection: "row", gap: space.sm }}>
                    <View style={{ flex: 1 }}>
                      <Button label="더 볼래요" onPress={() => void answer(false)} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button label="외웠어요" tone="primary" onPress={() => void answer(true)} />
                    </View>
                  </View>
                </>
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
                아직 글자로 바꾼 기록이 없어요. 티로 노트를 가져오면 여기에 쌓여요.
              </Body>
            </Card>
          ) : (
            transcriptRows.map((r) => {
              const started = new Date(r.startedAt);
              const clock = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
              const href = r.shiftId
                ? `/transcript/${encodeURIComponent(r.shiftId)}${
                    r.recId ? `?rec=${encodeURIComponent(r.recId)}` : ""
                  }`
                : null;
              const where = r.recId
                ? "따로 보는 파일"
                : r.files > 1
                  ? `파일 ${r.files}개 합침 · ${clock} 시작`
                  : `${clock} 시작`;
              return (
                <Pressable
                  key={r.key}
                  accessibilityRole="button"
                  disabled={!href}
                  onPress={() => href && router.push(href)}
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
                      <Text
                        style={[type.cardTitle, { color: t.text, flexShrink: 1 }]}
                        numberOfLines={1}
                      >
                        {setTitle(r.shiftId ?? undefined)}
                        {r.recId ? ` · ${r.label ?? `${clock} 파일`}` : ""}
                      </Text>
                      <Badge text={`${r.sentences}문장`} tone="muted" />
                    </View>
                    <Small>
                      {where}
                      {r.durationSec > 0 ? ` · ${Math.round(r.durationSec / 60)}분` : ""} · 눌러서
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
                  {search ? "찾는 카드가 없어요." : "카드가 없어요. 근무를 보내면 저절로 생겨요."}
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
                
  보고서가 없어요. 근무 기록에서 보내고 클로드에서 분석해요.
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
            
  보고서는 앱을 열 때마다 저절로 들어와요.
</Small>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
