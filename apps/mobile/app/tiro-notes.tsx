/**
 * 티로 노트 가져오기 — 티로 앱으로 녹음해 이미 전사된 노트를 이 앱으로.
 *
 * 폰에서 파일을 올리는 길(파일 전사 API)은 티로가 계정에 켜 줘야 열린다.
 * 안 켜져 있어도 이 길은 열려 있다 — 티로가 이미 받아적어 둔 것을 옮겨 온다.
 * 올릴 것이 없으니 기다림도, 파일 나누기도 없다.
 *
 * 고르는 것은 세 가지다. 노트 여럿 → 어느 근무 → 합칠지 따로 둘지.
 * 노트는 여러 편을 한 근무에 담을 수 있다 — 근무 하나를 여러 번 나눠 녹음한
 * 날이 흔하다. 담기는 차례는 고른 차례가 아니라 **녹음이 시작된 시각순**이다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { DEFAULT_TEMPLATES, toDateString, type ShiftCode } from "@nsr/core";
import { MonthGrid, type DayMark } from "../src/components/month-grid";
import { Body, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { CONTENT_MAX, TOUCH_MIN, radius, space, type, useTheme } from "../src/theme";
import {
  listDutyEntries,
  listRecordings,
  upsertDutyEntries,
  type RecordingRow,
} from "../src/db";
import { importTiroNotes, listTiroNotes, type TiroNote } from "../src/services/tiro-notes";

const CODES: ShiftCode[] = ["D", "E", "N", "ADM", "SPC", "EDU", "OTHER"];
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
/** 달력에 근무를 표시할 범위. 앞뒤로 넉넉히 읽어 두면 달을 넘겨도 안 비어 보인다. */
const MARK_MONTHS = 6;

function lengthText(sec: number): string {
  if (sec <= 0) return "길이 모름";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

function whenText(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${WEEKDAY[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function TiroNotes() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [notes, setNotes] = useState<TiroNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [date, setDate] = useState(() => toDateString(Date.now()));
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [code, setCode] = useState<ShiftCode>("D");
  const [entries, setEntries] = useState<Map<string, ShiftCode>>(new Map());
  const [existing, setExisting] = useState<RecordingRow[]>([]);
  const [separate, setSeparate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = useMemo(() => toDateString(Date.now()), []);
  // 고른 노트를 시각순으로 — 화면에 담기는 차례를 그대로 보여 준다.
  const chosen = useMemo(
    () => notes.filter((n) => picked.has(n.guid)).sort((a, b) => a.startedAt - b.startedAt),
    [notes, picked],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotes(await listTiroNotes());
    } catch (e) {
      setError(e instanceof Error ? e.message : "노트를 불러오지 못했어요. 다시 눌러 주세요.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 달력에 근무를 얹으려고 앞뒤 몇 달을 한꺼번에 읽어 둔다.
  useEffect(() => {
    const from = toDateString(new Date(anchor.year, anchor.month - MARK_MONTHS, 1).getTime());
    const to = toDateString(new Date(anchor.year, anchor.month + MARK_MONTHS + 1, 0).getTime());
    // 달을 빨리 넘기면 늦게 온 답이 이겨서 보이는 달의 근무가 지워진다.
    let stale = false;
    void listDutyEntries(from, to).then((list) => {
      if (!stale) setEntries(new Map(list.map((e) => [e.date, e.code])));
    });
    return () => {
      stale = true;
    };
  }, [anchor]);

  const codeColor = useCallback(
    (c: ShiftCode): string => {
      if (c === "D") return t.ok;
      if (c === "E") return t.warn;
      if (c === "N") return t.night;
      if (c === "ADM" || c === "SPC" || c === "EDU") return t.accent;
      return t.textMuted;
    },
    [t],
  );

  const marks = useMemo(() => {
    const m = new Map<string, DayMark>();
    for (const [d, c] of entries) {
      m.set(d, { label: DEFAULT_TEMPLATES[c]?.label?.slice(0, 2) ?? "?", color: codeColor(c) });
    }
    return m;
  }, [entries, codeColor]);

  const shiftId = `${date}:${code}`;
  useEffect(() => {
    let stale = false;
    void listRecordings(shiftId).then((r) => {
      if (!stale) setExisting(r);
    });
    return () => {
      stale = true;
    };
  }, [shiftId]);

  // 합치기/따로 카드가 안 보이면 그 값은 사용자가 고른 적 없는 값이다.
  // (노트 둘을 골라 '따로' 를 누른 뒤 하나를 다시 끄면 카드가 사라진다)
  const asksMerge = existing.length > 0 || chosen.length > 1;
  useEffect(() => {
    if (!asksMerge) setSeparate(false);
  }, [asksMerge]);

  const chooseDate = useCallback(
    (d: string) => {
      setDate(d);
      const c = entries.get(d);
      if (c && CODES.includes(c)) setCode(c);
    },
    [entries],
  );

  // 노트를 켜고 끈다. 첫 노트를 켤 때만 그 녹음이 있던 날로 따라간다 —
  // 둘째를 켤 때도 따라가면 사용자가 방금 고른 날이 조용히 바뀐다.
  const toggle = useCallback(
    (n: TiroNote) => {
      setError(null);
      // 갱신자 안에서 다른 상태를 건드리지 않는다 — 갱신자는 두 번 불릴 수
      // 있어서, 사용자가 방금 고른 날 위로 날짜 이동이 다시 얹힌다.
      const turningOn = !picked.has(n.guid);
      if (turningOn && picked.size === 0) {
        chooseDate(toDateString(n.startedAt));
        const d = new Date(n.startedAt);
        setAnchor({ year: d.getFullYear(), month: d.getMonth() });
      }
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(n.guid)) next.delete(n.guid);
        else next.add(n.guid);
        return next;
      });
    },
    [chooseDate, picked],
  );

  const submit = useCallback(async () => {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const out = await importTiroNotes({
        notes: chosen,
        date,
        code,
        separate,
        onProgress: (_pct: number, msg?: string) => setNote(msg ?? null),
      });
      // 하나가 막혀도 나머지는 들어갔다. 조용히 넘어가면 사용자는 다 들어온 줄 안다.
      if (out.failed.length > 0) {
        setError(
          `${out.imported}개는 가져왔어요. 못 가져온 것: ` +
            out.failed.map((f) => `${f.title} (${f.reason})`).join(", "),
        );
      }
      // 듀티표에 없는 날이면 적어 둔다 — 홈·듀티표에서도 이 근무가 보이게.
      const already = await listDutyEntries(date, date);
      if (already.length === 0) await upsertDutyEntries([{ date, code }]);
      // 못 가져온 것이 있으면 그 자리에 남아 읽게 둔다. 넘어가면 못 본다.
      if (out.failed.length > 0) {
        setBusy(false);
        setNote(null);
        setPicked(new Set());
        return;
      }
      // 합친 전사본 화면은 '따로 두기' 한 기록을 걸러 낸다. 그대로 보내면
      // 방금 가져온 사람이 "문장이 없어요" 를 본다.
      const rec = separate ? out.recordingIds[0] : undefined;
      router.replace({
        pathname: "/transcript/[id]",
        params: rec ? { id: out.shiftId, rec } : { id: out.shiftId },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "가져오지 못했어요. 다시 눌러 주세요.");
      setBusy(false);
      setNote(null);
    }
  }, [busy, chosen, code, date, existing.length, router, separate]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: insets.bottom + space.bottom,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
      keyboardShouldPersistTaps="handled"
    >
      {/* 1. 티로에 있는 노트 */}
      <Card>
        <Heading>티로에 있는 노트</Heading>
        <Small>여러 개 골라도 돼요. 시각 순서대로 담겨요.</Small>
        {loading ? (
          <Body muted>불러오는 중이에요.</Body>
        ) : notes.length === 0 ? (
          <Body muted>가져올 노트가 없어요.</Body>
        ) : (
          notes.map((n, i) => {
            const on = picked.has(n.guid);
            return (
              <View key={n.guid}>
                {i > 0 ? <Divider /> : null}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  onPress={() => toggle(n)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                    minHeight: TOUCH_MIN,
                    padding: space.sm,
                    borderRadius: radius.md,
                    backgroundColor: on ? t.accentSoft : "transparent",
                  }}
                >
                  <Ionicons
                    name={on ? "checkbox" : "square-outline"}
                    size={20}
                    color={on ? t.accent : t.textMuted}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text
                      style={[type.body, { color: t.text, fontWeight: "600" }]}
                      numberOfLines={1}
                    >
                      {n.title}
                    </Text>
                    <Text style={[type.small, { color: t.textMuted }]}>
                      {whenText(n.startedAt)} · {lengthText(n.durationSec)}
                    </Text>
                  </View>
                </Pressable>
              </View>
            );
          })
        )}
        <Button label="다시 불러오기" busy={loading} onPress={() => void load()} />
      </Card>

      {/* 2. 어느 근무 */}
      <Card>
        <Heading>어느 날 근무인가요</Heading>
        <Small>첫 노트를 고르면 그날로 따라가요.</Small>
        <MonthGrid
          year={anchor.year}
          month={anchor.month}
          onMonth={(year, month) => setAnchor({ year, month })}
          selected={date}
          onSelect={chooseDate}
          marks={marks}
          today={today}
        />
        <Divider />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {CODES.map((c) => {
            const on = c === code;
            return (
              <Pressable
                key={c}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setCode(c)}
                style={{
                  paddingVertical: space.sm,
                  paddingHorizontal: space.md,
                  borderRadius: radius.full,
                  backgroundColor: on ? t.accent : t.surfaceAlt,
                }}
              >
                <Text style={[type.small, { color: on ? "#FFFFFF" : t.text, fontWeight: "700" }]}>
                  {DEFAULT_TEMPLATES[c].label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Small muted={false}>
          {date} · {DEFAULT_TEMPLATES[code].label}
          {existing.length > 0 ? ` · 이 근무에 이미 기록 ${existing.length}개` : ""}
        </Small>
        {chosen.length > 0 ? (
          <Small>
            고른 노트 {chosen.length}개 · {whenText(chosen[0].startedAt)} 것부터 담아요.
          </Small>
        ) : null}
      </Card>

      {/* 3. 합치기 / 따로 — 합칠 것이 둘 이상일 때 묻는다.
             이미 있는 기록이 없어도, 노트를 여럿 골랐으면 그 자체가 갈림이다. */}
      {asksMerge ? (
        <Card>
          <Heading>합칠까요, 따로 둘까요</Heading>
          {[
            {
              on: !separate,
              title: "하나로 합치기",
              hint:
                existing.length > 0
                  ? "이 근무 기록 뒤에 이어 붙여요. 한 흐름일 때 골라요."
                  : "고른 노트를 한 전사본으로 이어 붙여요.",
              set: false,
            },
            {
              on: separate,
              title: "따로 두기",
              hint: "노트마다 전사본이 따로 생겨요. 다른 대화일 때 골라요.",
              set: true,
            },
          ].map((opt) => (
            <Pressable
              key={opt.title}
              accessibilityRole="radio"
              accessibilityState={{ checked: opt.on }}
              onPress={() => setSeparate(opt.set)}
              style={{
                flexDirection: "row",
                gap: space.md,
                alignItems: "flex-start",
                padding: space.md,
                borderRadius: radius.md,
                backgroundColor: opt.on ? t.accentSoft : t.surfaceAlt,
              }}
            >
              <Ionicons
                name={opt.on ? "radio-button-on" : "radio-button-off"}
                size={20}
                color={opt.on ? t.accent : t.textMuted}
                style={{ marginTop: 1 }}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.body, { color: t.text, fontWeight: "700" }]}>{opt.title}</Text>
                <Text style={[type.small, { color: t.textMuted }]}>{opt.hint}</Text>
              </View>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {note ? <Small muted={false}>{note}</Small> : null}
      {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
      <Button
        label={chosen.length > 1 ? `노트 ${chosen.length}개 가져오기` : chosen.length === 1 ? "노트 가져오기" : "노트부터 고르기"}
        tone="primary"
        busy={busy}
        onPress={() => {
          if (chosen.length === 0) {
            setError("위에서 노트를 골라 주세요.");
            return;
          }
          void submit();
        }}
      />
      <Small>소리는 티로에 남고 글자만 가져와요.</Small>
      <Small>가져온 글자는 폰 안에만 저장돼요.</Small>
    </ScrollView>
  );
}
