/**
 * 티로 노트 가져오기 — 티로 앱으로 녹음해 이미 전사된 노트를 이 앱으로.
 *
 * 폰에서 파일을 올리는 길(파일 전사 API)은 티로가 계정에 켜 줘야 열린다.
 * 안 켜져 있어도 이 길은 열려 있다 — 티로가 이미 받아적어 둔 것을 옮겨 온다.
 * 올릴 것이 없으니 기다림도, 파일 나누기도 없다.
 *
 * 고르는 것은 세 가지다. 노트 하나 → 어느 근무 → 합칠지 따로 둘지.
 * 화면 짜임새는 '음성 가져오기'(import-audio.tsx)와 일부러 같게 두었다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { DEFAULT_TEMPLATES, toDateString, type ShiftCode } from "@nsr/core";
import { Body, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { CONTENT_MAX, TOUCH_MIN, radius, space, type, useTheme } from "../src/theme";
import {
  listDutyEntries,
  listRecordings,
  upsertDutyEntries,
  type RecordingRow,
} from "../src/db";
import { importTiroNote, listTiroNotes, type TiroNote } from "../src/services/tiro-notes";

const CODES: ShiftCode[] = ["D", "E", "N", "ADM", "SPC", "EDU", "OTHER"];
const DAYS = 14;
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

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
  const [picked, setPicked] = useState<TiroNote | null>(null);
  const [date, setDate] = useState(() => toDateString(Date.now()));
  const [code, setCode] = useState<ShiftCode>("D");
  const [entries, setEntries] = useState<Map<string, ShiftCode>>(new Map());
  const [existing, setExisting] = useState<RecordingRow[]>([]);
  const [separate, setSeparate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(
    () =>
      Array.from({ length: DAYS }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return toDateString(d.getTime());
      }),
    [],
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

  useEffect(() => {
    void listDutyEntries(days[days.length - 1], days[0]).then((list) =>
      setEntries(new Map(list.map((e) => [e.date, e.code]))),
    );
  }, [days]);

  const shiftId = `${date}:${code}`;
  useEffect(() => {
    void listRecordings(shiftId).then(setExisting);
  }, [shiftId]);

  const chooseDate = useCallback(
    (d: string) => {
      setDate(d);
      const c = entries.get(d);
      if (c && CODES.includes(c)) setCode(c);
    },
    [entries],
  );

  // 노트를 고르면 그 녹음이 있던 날로 따라간다. 근무는 듀티표에서 온다.
  const choose = useCallback(
    (n: TiroNote) => {
      setPicked(n);
      setError(null);
      chooseDate(toDateString(n.startedAt));
    },
    [chooseDate],
  );

  const submit = useCallback(async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const out = await importTiroNote({
        note: picked,
        date,
        code,
        separate: existing.length > 0 && separate,
        onProgress: (_pct, msg) => setNote(msg ?? null),
      });
      // 듀티표에 없는 날이면 적어 둔다 — 홈·듀티표에서도 이 근무가 보이게.
      const already = await listDutyEntries(date, date);
      if (already.length === 0) await upsertDutyEntries([{ date, code }]);
      router.replace(`/transcript/${encodeURIComponent(out.shiftId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "가져오지 못했어요. 다시 눌러 주세요.");
      setBusy(false);
      setNote(null);
    }
  }, [busy, code, date, existing.length, picked, router, separate]);

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
        <Small>티로 앱으로 녹음한 것이 여기 나와요.</Small>
        {loading ? (
          <Body muted>불러오는 중이에요.</Body>
        ) : notes.length === 0 ? (
          <Body muted>가져올 노트가 없어요.</Body>
        ) : (
          notes.map((n, i) => {
            const on = picked?.guid === n.guid;
            return (
              <View key={n.guid}>
                {i > 0 ? <Divider /> : null}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => choose(n)}
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
                    name={on ? "radio-button-on" : "radio-button-off"}
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
        <Small>노트를 고르면 그날로 따라가요.</Small>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm, paddingVertical: space.xs }}
        >
          {days.map((d) => {
            const on = d === date;
            const dd = new Date(`${d}T00:00:00`);
            const entry = entries.get(d);
            return (
              <Pressable
                key={d}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => chooseDate(d)}
                style={{
                  minWidth: 60,
                  paddingVertical: space.sm,
                  paddingHorizontal: space.md,
                  borderRadius: radius.md,
                  backgroundColor: on ? t.accent : t.surfaceAlt,
                  alignItems: "center",
                  gap: 2,
                }}
              >
                <Text style={[type.small, { color: on ? "#FFFFFF" : t.textMuted }]}>
                  {WEEKDAY[dd.getDay()]}
                </Text>
                <Text style={[type.body, { color: on ? "#FFFFFF" : t.text, fontWeight: "700" }]}>
                  {dd.getMonth() + 1}/{dd.getDate()}
                </Text>
                <Text style={[type.caption, { color: on ? "#FFFFFF" : t.textMuted }]}>
                  {entry ? DEFAULT_TEMPLATES[entry].label : "—"}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
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
      </Card>

      {/* 3. 합치기 / 따로 — 그 근무에 이미 기록이 있을 때만 묻는다 */}
      {existing.length > 0 ? (
        <Card>
          <Heading>합칠까요, 따로 둘까요</Heading>
          {[
            {
              on: !separate,
              title: "하나로 합치기",
              hint: "이 근무 기록 뒤에 이어 붙여요. 한 흐름일 때 골라요.",
              set: false,
            },
            {
              on: separate,
              title: "따로 두기",
              hint: "전사본이 따로 생겨요. 다른 대화일 때 골라요.",
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
        label={picked ? "노트 가져오기" : "노트부터 고르기"}
        tone="primary"
        busy={busy}
        onPress={() => {
          if (!picked) {
            setError("위에서 노트를 하나 골라 주세요.");
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
