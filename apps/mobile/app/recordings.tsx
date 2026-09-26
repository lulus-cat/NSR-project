/**
 * 녹음 기록 — 저절로 켜진 기록이 **언제 켜졌고 무엇이 담겼는지** 보는 화면.
 *
 * 자동 기록은 사람이 안 보는 동안 도는 기능이라, 켜졌다는 증거가 화면에 없으면
 * 믿을 수가 없다. 예전에는 홈에 '안 보낸 녹음 3건' 만 있어서, 저절로 켜진
 * 것인지 내가 눌러 켠 것인지도, 몇 시에 켜졌는지도 알 길이 없었다.
 *
 * 이 화면의 일은 셋이다.
 *   1. 켠 주체를 밝힌다 — 듀티표 / 근무지 / 직접 / 티로에서 가져옴.
 *      (`recordings.owner` 열. 이 열이 생기기 전 기록은 '몰라요' 로 적는다.)
 *   2. 시점을 밝힌다 — 시작 시각과 길이. 근무 날짜로 묶는다(나이트는 새벽
 *      기록도 전날 근무에 붙는다 — 앱 전체가 쓰는 shift_id 규칙 그대로).
 *   3. 내용으로 가는 문 — 소리는 이 자리에서 듣고, 글자는 전사 결과 화면으로.
 *
 * 지우기·티로로 보내기는 여기 두지 않는다. 그건 근무 기록 화면(`/shift/[id]`)의
 * 일이고, 같은 단추를 두 곳에 두면 어디서 무엇을 했는지 헷갈린다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { DEFAULT_TEMPLATES, toDateString, type ShiftCode } from "@nsr/core";
import {
  Badge,
  Button,
  Card,
  ChipRow,
  Divider,
  GroupHeader,
  Heading,
  Small,
} from "../src/components/ui";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../src/theme";
import { listRecordingLog, type RecordingLogRow } from "../src/db";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 기록을 켠 쪽을 네 갈래로. 화면의 칩과 묶음이 같은 잣대를 쓰게 한 곳에 둔다.
 *
 * `owner` 열이 생기기 전 기록은 **이름으로** 갈린다 — 이름이 붙은 줄은 가져온
 * 것이고(녹음기가 만든 줄은 이름을 안 남긴다), 나머지는 정말 알 수 없다.
 * 듀티표와 근무지는 둘 다 사람 손이 안 닿았으니 한 갈래(auto)로 묶는다.
 */
type StarterKind = "auto" | "user" | "import" | "unknown";

function starterKind(r: RecordingLogRow): StarterKind {
  switch (r.owner) {
    case "tick":
    case "geofence":
      return "auto";
    case "user":
      return "user";
    case "import":
      return "import";
    default:
      return r.label ? "import" : "unknown";
  }
}

/** 누가 켰는지 사람 말로. 모르는 것은 모른다고 적는다. */
function starterText(r: RecordingLogRow): string {
  switch (r.owner) {
    case "tick":
      return "듀티표가 켰어요";
    case "geofence":
      return "근무지에서 켰어요";
    case "user":
      return "직접 켰어요";
    case "import":
      return "티로에서 가져왔어요";
    default:
      // owner 열이 생기기 전 기록. 이름이 붙어 있으면 가져온 것이다 —
      // 녹음기가 만든 줄은 이름을 안 남긴다.
      return r.label ? "티로에서 가져왔어요" : "누가 켰는지 몰라요";
  }
}

/** 녹음 상태를 배지로. 근무 기록 화면과 같은 말을 쓴다. */
function stateBadge(state: string): { text: string; tone: "ok" | "muted" | "warn" } {
  switch (state) {
    case "recorded":
      return { text: "안 보냄", tone: "warn" };
    case "sent":
      return { text: "티로에 보냄", tone: "muted" };
    case "transcribed":
      return { text: "다 바꿈", tone: "ok" };
    case "discarded":
      return { text: "버린 파일", tone: "muted" };
    default:
      return { text: "녹음 중", tone: "warn" };
  }
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function lengthText(sec: number): string {
  if (sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : `${Math.max(m, 1)}분`;
}

/**
 * 이 기록이 붙은 근무 날짜.
 *
 * `shift_id` 가 **빈 문자열**인 줄이 있다 — 주인 없이 남은 기록이 그렇다.
 * `?.` 로는 안 걸러지므로 `||` 로 받아 시작 시각의 날짜를 쓴다.
 */
function shiftDate(r: RecordingLogRow): string {
  return r.shift_id?.split(":")[0] || toDateString(r.started_at);
}

function dayText(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const wd = WEEKDAY[new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${wd})`;
}

/** 근무 날짜로 묶는다. 나이트의 새벽 기록도 전날 근무에 붙는다. */
interface DayGroup {
  key: string;
  title: string;
  rows: RecordingLogRow[];
}

function groupByDay(rows: RecordingLogRow[]): DayGroup[] {
  // 이웃끼리만 묶으면 같은 근무가 머리글 두 개로 쪼개진다 — 되찾은 기록은
  // 찾은 시각(오늘)으로 들어오는데 근무는 지난주다. 그래서 Map 으로 모은다.
  const map = new Map<string, DayGroup>();
  for (const r of rows) {
    const date = shiftDate(r);
    const code = r.shift_id ? r.shift_id.split(":")[1] : "";
    const key = r.shift_id || `없음:${date}`;
    const found = map.get(key);
    if (found) {
      found.rows.push(r);
      continue;
    }
    const label = DEFAULT_TEMPLATES[code as ShiftCode]?.label;
    map.set(key, {
      key,
      title: `${dayText(date)}${label ? ` · ${label}` : " · 근무 없음"}`,
      rows: [r],
    });
  }
  return [...map.values()];
}

const FILTERS: { key: StarterKind | "all"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "auto", label: "저절로" },
  { key: "user", label: "직접" },
  { key: "import", label: "가져옴" },
];

export default function Recordings() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<RecordingLogRow[]>([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listRecordingLog());
    } catch (e) {
      setError(e instanceof Error ? e.message : "기록을 읽지 못했어요. 앱을 다시 열어 주세요.");
    }
  }, []);

  // ── 듣기 — 근무 기록 화면과 같은 방식. 플레이어는 하나만 살려 둔다 ──
  const playerRef = useRef<AudioPlayer | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const stopPlay = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {
      // 이미 해제됐으면 그만이다.
    }
    playerRef.current = null;
    setPlayingId(null);
  }, []);

  // 화면을 떠나면 소리를 멈춘다. 탭으로 돌아가도 화면이 뒤에 남아 있어서,
  // 해제를 걸지 않으면 소리가 계속 흘러나온다.
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => stopPlay();
    }, [load, stopPlay]),
  );

  // 끝까지 재생되면 아이콘을 되돌린다.
  useEffect(() => {
    if (!playingId) return;
    const timer = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        if (p.duration > 0 && !p.playing && p.currentTime >= p.duration - 0.3) stopPlay();
      } catch {
        stopPlay();
      }
    }, 700);
    return () => clearInterval(timer);
  }, [playingId, stopPlay]);

  const togglePlay = useCallback(
    (r: RecordingLogRow) => {
      const same = playingId === r.id;
      stopPlay();
      if (same || !r.file_uri) return;
      try {
        const player = createAudioPlayer({ uri: r.file_uri });
        playerRef.current = player;
        player.play();
        setPlayingId(r.id);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "소리를 열지 못했어요. 파일이 남아 있는지 봐 주세요.",
        );
      }
    },
    [playingId, stopPlay],
  );

  const autos = useMemo(() => rows.filter((r) => starterKind(r) === "auto"), [rows]);
  const shown = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => starterKind(r) === filter)),
    [rows, filter],
  );
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const nowRecording = rows.some((r) => r.state === "recording");

  return (
    <ScrollView
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.lg + insets.bottom,
        gap: space.md,
      }}
    >
      {/* 이 화면에 온 이유에 먼저 답한다 — 저절로 켜졌나, 마지막이 언제였나. */}
      <Card tone="accent">
        <Heading>저절로 켜진 기록</Heading>
        {autos.length > 0 ? (
          <>
            <Small muted={false}>
              {autos.length}건이 쌓였어요.
            </Small>
            <Small>
              마지막은 {dayText(shiftDate(autos[0]))} {clock(autos[0].started_at)}에 켜졌어요.
            </Small>
          </>
        ) : (
          <>
            <Small muted={false}>아직 저절로 켜진 적이 없어요.</Small>
            {rows.some((r) => starterKind(r) === "unknown") ? (
              <Small>예전 기록은 누가 켰는지 몰라요.</Small>
            ) : null}
            <Small>설정에서 자동 기록을 켜 주세요.</Small>
            <Button label="설정 열기" onPress={() => router.push("/settings")} />
          </>
        )}
        {nowRecording ? <Small muted={false}>지금 기록하고 있어요.</Small> : null}
      </Card>

      {error ? (
        <Card tone="warn">
          <Small muted={false}>{error}</Small>
        </Card>
      ) : null}

      <ChipRow items={FILTERS} active={filter} onSelect={setFilter} />

      {shown.length === 0 ? (
        <Card>
          <Small muted={false}>여기 보일 기록이 없어요.</Small>
          <Small>기록이 생기면 날짜별로 쌓여요.</Small>
        </Card>
      ) : null}

      {groups.map((g) => (
        <View key={g.key} style={{ gap: space.xs }}>
          <GroupHeader>{g.title}</GroupHeader>
          <Card style={{ gap: 0 }}>
            {g.rows.map((r, i) => {
              const badge = stateBadge(r.state);
              const playing = playingId === r.id;
              const mb = r.size_bytes > 0 ? `${(r.size_bytes / (1024 * 1024)).toFixed(1)}MB` : null;
              const meta = [starterText(r), mb, r.sentences > 0 ? `${r.sentences}문장` : null]
                .filter(Boolean)
                .join(" · ");
              // 글자가 있으면 전사 결과로, 없으면 그 근무의 기록 화면으로 보낸다.
              const open = r.sentences > 0 && r.shift_id
                ? () =>
                    router.push(
                      `/transcript/${encodeURIComponent(r.shift_id!)}?rec=${encodeURIComponent(r.id)}`,
                    )
                : r.shift_id
                  ? () => router.push(`/shift/${encodeURIComponent(r.shift_id!)}`)
                  : undefined;
              return (
                <View key={r.id}>
                  {i > 0 ? <Divider /> : null}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.md,
                      minHeight: TOUCH_MIN,
                      paddingVertical: space.sm,
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={playing ? "그만 듣기" : "들어 보기"}
                      disabled={!r.file_uri}
                      onPress={() => togglePlay(r)}
                      style={({ pressed }) => ({
                        width: TOUCH_MIN,
                        height: TOUCH_MIN,
                        borderRadius: radius.full,
                        backgroundColor: playing ? t.surfaceRaised : t.surfaceAlt,
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: r.file_uri ? 1 : 0.4,
                        transform: [{ scale: pressed ? 0.94 : 1 }],
                      })}
                    >
                      <Ionicons name={playing ? "stop" : "play"} size={18} color={t.accent} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={!open}
                      onPress={open}
                      style={{ flex: 1, gap: 2 }}
                    >
                      <Text
                        style={[type.body, TABULAR, { color: t.text, fontWeight: "600" }]}
                        numberOfLines={1}
                      >
                        {clock(r.started_at)} 시작
                        {lengthText(r.duration_sec) ? ` · ${lengthText(r.duration_sec)}` : ""}
                      </Text>
                      <Text
                        style={[type.small, { color: t.textMuted, fontWeight: "600" }]}
                        numberOfLines={1}
                      >
                        {meta}
                        {r.file_uri ? "" : " · 소리 없음"}
                      </Text>
                      {/* 왜 버렸는지는 여기 말고 적을 자리가 없다. */}
                      {r.discard_reason ? (
                        <Text
                          style={[type.small, { color: t.textMuted, fontWeight: "600" }]}
                          numberOfLines={2}
                        >
                          {r.discard_reason}
                        </Text>
                      ) : null}
                    </Pressable>
                    <Badge text={badge.text} tone={badge.tone} />
                    {open ? (
                      <Ionicons name="chevron-forward" size={16} color={t.textMuted} />
                    ) : null}
                  </View>
                </View>
              );
            })}
          </Card>
        </View>
      ))}

      {rows.length > 0 ? (
        <Small>소리는 보관기간이 지나면 저절로 지워져요.</Small>
      ) : null}
    </ScrollView>
  );
}
