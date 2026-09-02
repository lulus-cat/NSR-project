/**
 * 음성 가져오기 — 다른 앱(다글로·기본 음성 메모 등)의 파일을 이 앱의 기록으로.
 *
 * 세 가지를 여기서 정한다.
 *   1. 파일 — 여러 개를 한 번에 고른다.
 *   2. 어느 근무인가 — 날짜와 듀티. 예전엔 '오늘'에 자동으로 붙어서, 어제
 *      녹음을 오늘 올리면 엉뚱한 날의 기록이 됐다.
 *   3. 합칠지 따로 둘지 — 파일이 여럿이거나 그 근무에 이미 기록이 있을 때.
 *      30분마다 잘린 녹음은 한 흐름이니 합치고, 다른 대화면 따로 둔다.
 *      따로 둔 파일은 전사 결과도, 학습 탭의 목록도 제 줄을 가진다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
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
import {
  pickAudioFiles,
  registerImportedAudio,
  type PickedAudio,
} from "../src/services/import-audio";

/** 고를 수 있는 듀티. 휴무·연차·병가에 녹음이 있을 리 없어 '기타'로 뭉친다. */
const CODES: ShiftCode[] = ["D", "E", "N", "ADM", "SPC", "EDU", "OTHER"];
const DAYS = 14;
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function mb(bytes: number): string {
  return bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : "크기 모름";
}

type Mode = "merge" | "separate";

export default function ImportAudio() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [files, setFiles] = useState<PickedAudio[]>([]);
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState(() => toDateString(Date.now()));
  const [dateText, setDateText] = useState("");
  const [code, setCode] = useState<ShiftCode>("D");
  const [entries, setEntries] = useState<Map<string, ShiftCode>>(new Map());
  const [existing, setExisting] = useState<RecordingRow[]>([]);
  const [mode, setMode] = useState<Mode>("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 오늘부터 거꾸로 2주. 더 오래된 날은 아래 칸에 직접 적는다.
  const days = useMemo(
    () =>
      Array.from({ length: DAYS }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return toDateString(d.getTime());
      }),
    [],
  );

  // 듀티표를 읽어 두면 날짜를 고를 때 그날 듀티가 저절로 잡힌다.
  useEffect(() => {
    void listDutyEntries(days[days.length - 1], days[0]).then((list) => {
      const map = new Map(list.map((e) => [e.date, e.code]));
      setEntries(map);
      const today = map.get(days[0]);
      if (today && CODES.includes(today)) setCode(today);
    });
  }, [days]);

  const pick = useCallback(async (): Promise<number> => {
    setPicking(true);
    try {
      const got = await pickAudioFiles();
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.uri));
        return [...prev, ...got.filter((f) => !seen.has(f.uri))];
      });
      return got.length;
    } catch (e) {
      setError(e instanceof Error ? e.message : "파일 선택창을 못 열었습니다.");
      return 0;
    } finally {
      setPicking(false);
    }
  }, []);

  // 화면이 열리면 바로 선택창부터 — 고르는 것이 이 화면의 첫 일이다.
  // 아무것도 안 고르고 닫으면 돌아간다.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void pick().then((n) => {
      if (n === 0) router.back();
    });
  }, [pick, router]);

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

  const applyDateText = useCallback(() => {
    const v = dateText.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T00:00:00`).getTime())) {
      setError("날짜는 2026-08-24 처럼 적어 주세요.");
      return;
    }
    setError(null);
    chooseDate(v);
  }, [chooseDate, dateText]);

  // 합칠지 물을 일이 있는가 — 파일이 여럿이거나 그 근무에 이미 기록이 있을 때.
  const askMerge = files.length > 1 || existing.length > 0;
  const dutyLabel = DEFAULT_TEMPLATES[code].label;

  const submit = useCallback(async () => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await registerImportedAudio({
        files,
        date,
        code,
        separate: askMerge && mode === "separate",
      });
      // 듀티표에 없는 날이면 적어 둔다 — 홈·듀티표에서도 이 근무가 보이게.
      // 있는 날은 건드리지 않는다: 듀티표가 맞고 여기 고른 것이 틀릴 수도 있다.
      const already = await listDutyEntries(date, date);
      if (already.length === 0) await upsertDutyEntries([{ date, code }]);
      router.replace(`/shift/${encodeURIComponent(out.shiftId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "파일을 가져오지 못했습니다.");
      setBusy(false);
    }
  }, [askMerge, busy, code, date, files, mode, router]);

  const options: { key: Mode; title: string; hint: string }[] = [
    {
      key: "merge",
      title: "한 전사본으로 합치기",
      hint:
        existing.length > 0
          ? "이 근무에 있던 기록 뒤에 이어 붙입니다. 30분마다 잘린 녹음처럼 사실은 한 흐름일 때."
          : "고른 파일들을 차례로 이어 한 전사본으로 봅니다. 30분마다 잘린 녹음처럼 사실은 한 흐름일 때.",
    },
    {
      key: "separate",
      title: "파일마다 따로 두기",
      hint: "파일마다 전사본이 따로 생기고, 학습 탭에도 따로 보입니다. 다른 대화·다른 시간대일 때.",
    },
  ];

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
      {/* 1. 파일 */}
      <Card>
        <Heading>가져올 파일</Heading>
        {files.length === 0 ? (
          <Body muted>아직 고른 파일이 없습니다.</Body>
        ) : (
          files.map((f, i) => (
            <View key={f.uri}>
              {i > 0 ? <Divider /> : null}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.md,
                  minHeight: TOUCH_MIN,
                }}
              >
                <Ionicons name="musical-notes-outline" size={18} color={t.accent} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text
                    style={[type.body, { color: t.text, fontWeight: "600" }]}
                    numberOfLines={1}
                  >
                    {f.name}
                  </Text>
                  <Text style={[type.small, { color: t.textMuted }]}>{mb(f.size)}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="이 파일 빼기"
                  onPress={() => setFiles((prev) => prev.filter((x) => x.uri !== f.uri))}
                  style={{
                    width: TOUCH_MIN,
                    height: TOUCH_MIN,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons name="close-circle-outline" size={20} color={t.textMuted} />
                </Pressable>
              </View>
            </View>
          ))
        )}
        <Button
          label={files.length > 0 ? "파일 더 고르기" : "파일 고르기"}
          busy={picking}
          onPress={() => void pick()}
        />
      </Card>

      {/* 2. 어느 근무 */}
      <Card>
        <Heading>어느 날 근무 기록인가요?</Heading>
        <Small>날짜를 고르면 듀티표의 그날 듀티가 따라옵니다. 다르면 아래에서 바꾸세요.</Small>
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
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <TextInput
            value={dateText}
            onChangeText={setDateText}
            placeholder="더 오래된 날은 2026-08-24 처럼"
            placeholderTextColor={t.textMuted}
            onSubmitEditing={applyDateText}
            style={{
              flex: 1,
              minHeight: TOUCH_MIN,
              paddingHorizontal: space.md,
              borderRadius: radius.md,
              backgroundColor: t.surfaceAlt,
              color: t.text,
              fontSize: 15,
            }}
          />
          <Button label="적용" onPress={applyDateText} />
        </View>
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
          {date} · {dutyLabel}
          {existing.length > 0 ? ` · 이 근무에 이미 기록 ${existing.length}개` : ""}
        </Small>
      </Card>

      {/* 3. 합치기 / 따로 */}
      {askMerge ? (
        <Card>
          <Heading>합칠까요, 따로 둘까요?</Heading>
          {options.map((opt) => {
            const on = mode === opt.key;
            return (
              <Pressable
                key={opt.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setMode(opt.key)}
                style={{
                  flexDirection: "row",
                  gap: space.md,
                  alignItems: "flex-start",
                  padding: space.md,
                  borderRadius: radius.md,
                  backgroundColor: on ? t.accentSoft : t.surfaceAlt,
                }}
              >
                <Ionicons
                  name={on ? "radio-button-on" : "radio-button-off"}
                  size={20}
                  color={on ? t.accent : t.textMuted}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[type.body, { color: t.text, fontWeight: "700" }]}>{opt.title}</Text>
                  <Text style={[type.small, { color: t.textMuted }]}>{opt.hint}</Text>
                </View>
              </Pressable>
            );
          })}
        </Card>
      ) : null}

      {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
      <Button
        label={
          files.length > 0
            ? `${files.length}개 파일을 ${dutyLabel} 기록으로 가져오기`
            : "먼저 파일을 고르세요"
        }
        tone="primary"
        busy={busy}
        disabled={files.length === 0}
        onPress={() => void submit()}
      />
      <Small>가져온 파일은 폰 안에만 복사됩니다. 전사는 근무 기록 화면에서 시작합니다.</Small>
    </ScrollView>
  );
}
