/**
 * 전사 결과 — 이 화면의 일은 딱 하나, 전사본을 읽고 다듬는 것이다.
 *
 * 근무 기록 화면에서 분리했다: 전사 실행·보고서와 한 화면에 두면
 * 전사가 끝나는 순간 수천 문장이 그 화면에 쏟아져 모든 것이 무거워진다.
 * 여기는 처음부터 가상 목록(FlatList) 하나로 짜여 있어 3시간 기록도 연다.
 *
 * 손가락 문법:
 *   문장 누르기       → 그 시점부터 재생
 *   머리줄(배지) 누르기 → 화자 구간 지정의 시작/끝
 *   단어 길게 누르기   → 고치기·사전 등록
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import {
  DEFAULT_TEMPLATES,
  assignSpeakerRange,
  josa,
  recordCorrection,
  speakerCoverage,
  type SpeakerRole,
  type TranscriptSegment,
  type ShiftCode,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../../src/components/ui";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  deleteShiftRecordings,
  deleteTranscript,
  getPipelineJob,
  getSetting,
  listRecordings,
  listSegments,
  listUserTerms,
  loadCorrectionMemory,
  saveCorrectionMemory,
  saveUserTerm,
  setSetting,
  setSpeakerRole,
  setSpeakerRoleForCluster,
  updateSegmentText,
  type RecordingRow,
} from "../../src/db";
import { loadLexicon } from "../../src/services/asr";
import { redactForExport, shareText } from "../../src/services/export";
import { exportBaseName, transcriptToText } from "../../src/services/export-bundle";

const ROLE_OPTIONS: { role: SpeakerRole; label: string }[] = [
  { role: "self", label: "나" },
  { role: "senior", label: "선배" },
  { role: "doctor", label: "의사" },
  { role: "patient", label: "환자" },
  { role: "guardian", label: "보호자" },
  { role: "other", label: "기타" },
];

const ROLE_LABELS: Record<SpeakerRole, string> = {
  self: "나",
  senior: "선배",
  doctor: "의사",
  patient: "환자",
  guardian: "보호자",
  other: "기타",
  unknown: "모름",
};

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 이 문장이 어느 기록(파일)의 것인가. DB 가 준 recording_id 를 쓴다.
 * 예전 판은 세그먼트 id(`${recordingId}#s{n}.{m}`)의 앞부분을 잘라 썼는데, 합친 전사본에서
 * 그 추측이 빗나가면 재생할 파일을 못 찾았다. id 파싱은 recording_id 가 없을 때의 예비다.
 */
function recordingIdOf(segment: TranscriptSegment & { recordingId?: string }): string {
  return segment.recordingId ?? segment.id.split("#s")[0];
}

/** 화자 분리 결과의 라벨(SPEAKER_00 등)을 사람이 부를 이름으로. */
function speakerName(speakerId: string, order: string[]): string {
  const i = order.indexOf(speakerId);
  return `목소리 ${i >= 0 ? i + 1 : "?"}`;
}

/**
 * 전사 한 줄 — 다글로식. 발언마다 왼쪽에 시점이 붙는다.
 * 화자가 바뀌는 줄에는 화자 머리줄이 하나 더 얹힌다.
 */
const SentenceRow = memo(function SentenceRow({
  segment,
  showHeader,
  headerLabel,
  isRangeStart,
  isPlaying,
  onPressHeader,
  onPressSentence,
  onPressWord,
}: {
  segment: TranscriptSegment;
  showHeader: boolean;
  headerLabel: string;
  isRangeStart: boolean;
  isPlaying: boolean;
  onPressHeader: (id: string) => void;
  onPressSentence: (segment: TranscriptSegment) => void;
  onPressWord: (segmentId: string, word: string) => void;
}) {
  const t = useTheme();
  const role = segment.speakerRole ?? "unknown";
  const words = segment.text.split(/(\s+)/).filter((w) => w.length > 0);

  return (
    <View style={{ paddingHorizontal: space.lg }}>
      {showHeader ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${headerLabel} — 눌러서 누구인지 정하기`}
          onPress={() => onPressHeader(segment.id)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            marginTop: space.md,
            marginBottom: space.xs,
            minHeight: 28,
          }}
        >
          <Badge
            text={headerLabel}
            tone={role === "self" ? "ok" : role === "unknown" ? "warn" : "muted"}
          />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="여기부터 듣기"
        onPress={() => onPressSentence(segment)}
        style={{
          flexDirection: "row",
          gap: space.sm,
          borderRadius: radius.md,
          backgroundColor: isRangeStart
            ? t.accentSoft
            : isPlaying
              ? t.surfaceAlt
              : "transparent",
          paddingVertical: space.xs,
          paddingHorizontal: space.sm,
        }}
      >
        {/* 발언 시점 — 매 줄에 붙는다. 글자수 비례 추정이라 "대충 그 근처"용이다. */}
        <Text
          style={[
            type.caption,
            TABULAR,
            { color: isPlaying ? t.accent : t.textMuted, minWidth: 44, marginTop: 3 },
          ]}
        >
          {formatTime(segment.startSec)}
        </Text>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
            {words.map((word, i) =>
              /^\s+$/.test(word) ? (
                <Text key={i} style={[type.body, { color: t.text }]}>
                  {" "}
                </Text>
              ) : (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  accessibilityLabel={`${word} — 길게 눌러 고치기`}
                  onPress={() => onPressSentence(segment)}
                  onLongPress={() => onPressWord(segment.id, word)}
                  delayLongPress={300}
                >
                  <Text style={[type.body, { color: t.text }]}>{word}</Text>
                </Pressable>
              ),
            )}
          </View>
          {segment.text !== segment.rawText ? (
            <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
              원문: {segment.rawText}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
});

/**
 * 재생 진행바 — 누르거나 끌어서 그 위치로 간다.
 * 네이티브 슬라이더 의존성을 안 쓰는 이유: 빌드가 깨질 물건을 하나 덜
 * 들이는 쪽이 낫고, 필요한 동작(탭·드래그 탐색)은 responder 로 충분하다.
 */
function SeekBar({
  positionSec,
  durationSec,
  onSeek,
}: {
  positionSec: number;
  durationSec: number;
  onSeek: (sec: number) => void;
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  // 끌고 있는 동안은 손가락 위치를 보여준다 — 틱이 되돌려 놓으면 조작감이 죽는다.
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  const toSec = (x: number) =>
    durationSec > 0 && width > 0 ? Math.min(1, Math.max(0, x / width)) * durationSec : 0;
  const shownSec = scrubSec ?? positionSec;
  const ratio = durationSec > 0 ? Math.min(1, Math.max(0, shownSec / durationSec)) : 0;
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="듣는 위치"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => durationSec > 0}
      onMoveShouldSetResponder={() => durationSec > 0}
      onResponderGrant={(e) => setScrubSec(toSec(e.nativeEvent.locationX))}
      onResponderMove={(e) => setScrubSec(toSec(e.nativeEvent.locationX))}
      onResponderRelease={(e) => {
        setScrubSec(null);
        onSeek(toSec(e.nativeEvent.locationX));
      }}
      onResponderTerminate={() => setScrubSec(null)}
      style={{ height: 32, justifyContent: "center" }}
    >
      <View
        style={{ height: 4, borderRadius: 2, backgroundColor: t.surfaceAlt, overflow: "hidden" }}
      >
        <View
          style={{ width: `${ratio * 100}%`, height: 4, backgroundColor: t.accent }}
        />
      </View>
      {width > 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: Math.min(Math.max(ratio * width - 7, 0), width - 14),
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: t.accent,
          }}
        />
      ) : null}
    </View>
  );
}

/** 배속 순환 목록 — 인계 복기는 빨리 듣기가 기본이라 2.0 까지 둔다. */
const RATES = [1.0, 1.25, 1.5, 2.0];

export default function TranscriptView() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; rec?: string }>();
  const shiftId = decodeURIComponent(params.id ?? "");
  // rec 가 있으면 '따로' 둔 파일 하나의 전사본이다. 없으면 합친 전사본.
  const recId =
    typeof params.rec === "string" && params.rec ? decodeURIComponent(params.rec) : undefined;
  const [date, code] = shiftId.split(":");
  const dutyLabel = DEFAULT_TEMPLATES[(code as ShiftCode) ?? "OTHER"]?.label ?? "듀티";

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recLabel = recId
    ? (recordings.find((r) => r.id === recId)?.label ?? "따로 보는 파일")
    : null;

  /** AI 에게 함께 실려 가는 것 — 내 단어장과 확정된 교정 규칙. 눈에 보여야 믿는다. */
  const [dictInfo, setDictInfo] = useState<{ terms: number; confirmed: number } | null>(null);
  const loadDictInfo = useCallback(async () => {
    const [terms, memory] = await Promise.all([listUserTerms(), loadCorrectionMemory()]);
    const confirmed = Object.values(memory.rules).filter(
      (r) => r.count >= memory.minCount,
    ).length;
    setDictInfo({ terms: terms.length, confirmed });
  }, []);

  const load = useCallback(async () => {
    const [segs, recs] = await Promise.all([
      listSegments(shiftId, recId ? { recordingId: recId } : { mergedOnly: true }),
      listRecordings(shiftId),
    ]);
    setSegments(segs);
    // 재생·삭제가 이 화면에 보이는 문장과 같은 파일을 가리켜야 한다 — 따로 보는
    // 파일이면 그 파일만, 합친 전사본이면 따로 둔 파일을 뺀 나머지만.
    setRecordings(recs.filter((r) => (recId ? r.id === recId : r.separate !== 1)));
    await loadDictInfo();
  }, [shiftId, recId, loadDictInfo]);

  useEffect(() => {
    void load();
    // 홈의 '새 전사 결과' 알림은 이 화면을 열면 읽은 것이다.
    void (async () => {
      const last = await getSetting<{ shiftId?: string; seen?: boolean }>(
        "transcribe.lastResult",
        {},
      );
      if (last.shiftId === shiftId && !last.seen) {
        await setSetting("transcribe.lastResult", { ...last, seen: true });
      }
    })();
  }, [load, shiftId]);

  const coverage = useMemo(() => speakerCoverage(segments), [segments]);
  const speakerOrder = useMemo(() => {
    const order: string[] = [];
    for (const s of segments) {
      if (s.speakerId && !order.includes(s.speakerId)) order.push(s.speakerId);
    }
    return order;
  }, [segments]);

  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<SpeakerRole>("senior");
  const [wordTarget, setWordTarget] = useState<
    { segmentId: string; word: string; replacement: string } | null
  >(null);

  // ── 재생 ──────────────────────────────────────────────
  const playerRef = useRef<AudioPlayer | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const pendingSeekTriesRef = useRef(0);
  const [playback, setPlayback] = useState<
    { recordingId: string; positionSec: number; durationSec: number; playing: boolean } | null
  >(null);
  // 배속은 화면을 나가도 기억한다 — 복기 습관은 기록마다 같다.
  const [rate, setRate] = useState(1.0);
  useEffect(() => {
    void (async () => {
      const saved = await getSetting<number>("transcript.playbackRate", 1.0);
      if (RATES.includes(saved)) setRate(saved);
    })();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        // 파일이 실릴 때까지 기다렸다가 원하는 지점으로 옮긴다. 소스를 갈아 끼운 직후에는
        // isLoaded 가 잠깐 거짓이고 duration 이 이전 파일 값일 수 있어 둘 다 본다.
        // 한 번 옮겨서 안 맞으면 몇 틱 더 시도한다 (실기기에서 첫 seek 가 먹지 않는 일이 있다).
        if (pendingSeekRef.current !== null && p.isLoaded && p.duration > 0) {
          const target = pendingSeekRef.current;
          if (Math.abs(p.currentTime - target) > 2) {
            void p.seekTo(target);
            pendingSeekTriesRef.current += 1;
            if (pendingSeekTriesRef.current >= 6) pendingSeekRef.current = null;
          } else {
            pendingSeekRef.current = null;
          }
        }
        setPlayback((prev) => {
          if (!prev) return prev;
          if (
            Math.floor(prev.positionSec) === Math.floor(p.currentTime) &&
            prev.playing === p.playing &&
            Math.floor(prev.durationSec) === Math.floor(p.duration)
          ) {
            return prev;
          }
          return {
            ...prev,
            positionSec: p.currentTime,
            durationSec: p.duration,
            playing: p.playing,
          };
        });
      } catch {
        // 플레이어가 해제된 직후의 틱.
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      try {
        playerRef.current?.remove();
      } catch {
        // 이미 해제됐으면 그만이다.
      }
    },
    [],
  );

  const stopPlayback = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {
      // 이미 해제된 플레이어.
    }
    playerRef.current = null;
    pendingSeekRef.current = null;
    setPlayback(null);
  }, []);

  // 이 화면을 떠나면 소리를 멈춘다. 예전에는 재생 중에 다른 화면으로 넘어가도
  // 계속 흘러나왔다 — 화면이 사라지지 않는(뒤에 남는) 길로 나가면 해제가 안 됐다.
  // 멈추기만 하고 플레이어는 남긴다. 돌아오면 듣던 자리에서 다시 누를 수 있다.
  useFocusEffect(
    useCallback(
      () => () => {
        try {
          playerRef.current?.pause();
        } catch {
          // 이미 해제된 플레이어.
        }
        setPlayback((prev) => (prev ? { ...prev, playing: false } : prev));
      },
      [],
    ),
  );

  const playRecording = useCallback(
    (recId: string, atSec: number) => {
      const rec = recordings.find((r) => r.id === recId);
      if (!rec) {
        setNotice("이 문장의 음성 파일이 목록에 없어요. 근무 기록에서 파일을 확인해 주세요.");
        return;
      }
      if (!rec.file_uri) {
        setNotice(`${rec.label ?? "음성 파일"}이 폰에 없어요. 파일을 다시 가져와 주세요.`);
        return;
      }
      try {
        const sameFile = playerRef.current !== null && playback?.recordingId === recId;
        if (!playerRef.current) {
          const player = createAudioPlayer({ uri: rec.file_uri });
          playerRef.current = player;
          try {
            player.setPlaybackRate(rate, "high");
          } catch {
            // 배속 미지원 기기 — 1배속으로 계속한다.
          }
        } else if (!sameFile) {
          // 합친 전사본에서 다른 파일의 문장을 누른 경우. 플레이어를 해제하고 새로 만들면
          // 안드로이드에서 소리 없이 실패하는 일이 있어, 하나의 플레이어에 소스만 갈아 끼운다.
          playerRef.current.replace({ uri: rec.file_uri });
        }
        const player = playerRef.current;
        pendingSeekTriesRef.current = 0;
        if (sameFile && player.isLoaded) {
          pendingSeekRef.current = null;
          void player.seekTo(atSec);
        } else {
          // 아직 실리지 않았다. 실리면 위의 주기 확인이 원하는 지점으로 옮긴다.
          pendingSeekRef.current = atSec;
        }
        player.play();
        setPlayback((prev) => ({
          recordingId: recId,
          positionSec: atSec,
          durationSec: sameFile && prev ? prev.durationSec : rec.duration_sec || 0,
          playing: true,
        }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "소리를 열지 못했어요. 다시 눌러 주세요.");
      }
    },
    [playback?.recordingId, rate, recordings],
  );

  const playFrom = useCallback(
    (segment: TranscriptSegment) => {
      playRecording(recordingIdOf(segment), segment.startSec);
    },
    [playRecording],
  );

  /** 진행바 탐색 — 재생 중인 기록 안에서 그 시각으로 간다. */
  const seekTo = useCallback((sec: number) => {
    const p = playerRef.current;
    if (!p) return;
    try {
      pendingSeekRef.current = null;
      void p.seekTo(sec);
      setPlayback((prev) => (prev ? { ...prev, positionSec: sec } : prev));
    } catch {
      // 해제 직후 — 다음 틱이 맞춘다.
    }
  }, []);

  /** 배속 순환: 1.0 → 1.25 → 1.5 → 2.0 → 1.0 */
  const cycleRate = useCallback(() => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    void setSetting("transcript.playbackRate", next);
    try {
      playerRef.current?.setPlaybackRate(next, "high");
    } catch {
      // 배속 미지원 — 표시만 바뀌고 소리는 그대로다.
    }
  }, [rate]);

  const togglePause = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      if (p.playing) p.pause();
      else p.play();
      const nowPlaying = p.playing;
      setPlayback((prev) => (prev ? { ...prev, playing: nowPlaying } : prev));
    } catch {
      // 해제 직후 — 표시 상태는 틱이 맞춘다.
    }
  }, []);

  const playingRowId = useMemo(() => {
    if (!playback) return null;
    const hit = segments.find(
      (s) =>
        recordingIdOf(s) === playback.recordingId &&
        playback.positionSec >= s.startSec &&
        playback.positionSec < Math.max(s.endSec, s.startSec + 1),
    );
    return hit?.id ?? null;
  }, [playback, segments]);

  // ── 화자 지정 ─────────────────────────────────────────
  const toggleRange = useCallback(
    async (segmentId: string) => {
      if (!rangeStart) {
        setRangeStart(segmentId);
        return;
      }
      const next = assignSpeakerRange(segments, rangeStart, segmentId, pendingRole);
      setRangeStart(null);
      setSegments(next);
      const changed = next.filter((n, i) => n.speakerRole !== segments[i]?.speakerRole);
      for (const seg of changed) {
        if (seg.speakerRole) await setSpeakerRole(seg.id, seg.speakerRole);
      }
    },
    [pendingRole, rangeStart, segments],
  );

  const assignCluster = useCallback(
    async (speakerId: string) => {
      await setSpeakerRoleForCluster(shiftId, speakerId, pendingRole);
      setSegments((prev) =>
        prev.map((s) => (s.speakerId === speakerId ? { ...s, speakerRole: pendingRole } : s)),
      );
    },
    [pendingRole, shiftId],
  );

  // ── 단어 고치기 ───────────────────────────────────────
  const applyWordFix = useCallback(async () => {
    if (!wordTarget) return;
    const { segmentId, word, replacement } = wordTarget;
    const to = replacement.trim();
    const seg = segments.find((x) => x.id === segmentId);
    if (!seg || !to || to === word) return;

    const nextText = seg.text.replace(word, to);
    setSegments((prev) =>
      prev.map((x) => (x.id === segmentId ? { ...x, text: nextText } : x)),
    );
    setWordTarget(null);

    await updateSegmentText(segmentId, nextText);
    const memory = await loadCorrectionMemory();
    await saveCorrectionMemory(recordCorrection(memory, word, to, Date.now()));
    await loadDictInfo();
  }, [loadDictInfo, segments, wordTarget]);

  const addToMyDict = useCallback(async () => {
    if (!wordTarget) return;
    const surface = wordTarget.word.trim();
    if (surface.length < 2) {
      setError("두 글자 이상 적어 주세요.");
      return;
    }
    await saveUserTerm({
      id: `user-${Date.now().toString(36)}`,
      ko: surface,
      aliases: [],
      category: "workflow",
      definition: "우리 병동 말이에요. 뜻을 적어 주세요.",
    });
    setWordTarget(null);
    setError(null);
    setNotice(`'${surface}'${josa(surface, "을")} 단어장에 넣었어요. 뜻은 단어장에서 적어요.`);
    await loadDictInfo();
  }, [loadDictInfo, wordTarget]);

  const onPressWord = useCallback((segmentId: string, word: string) => {
    setWordTarget({ segmentId, word, replacement: word });
  }, []);


  // ── 삭제 — 전사만 지울지, 녹음까지 지울지 그 자리에서 고른다 ──
  /**
   * 전사본을 텍스트 파일로 빼낸다.
   *
   * 파일이 폰 밖으로 나가는 길이라 `redactForExport` 를 지나고, 무엇을 몇 건
   * 가렸는지 눈으로 확인한 뒤에야 공유 창이 열린다.
   */
  const runExport = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("파일 만드는 중");
    try {
      const red = await redactForExport(transcriptToText(segments, { date, dutyLabel }));
      const warn = red.warnings.map((w) => `· ${w.message}`).join("\n");
      Alert.alert(
        "전사본을 파일로 만들까요",
        `${red.summary}\n${warn ? `${warn}\n` : ""}\n` +
          "파일을 만들면 보낼 곳을 고르는 창이 열려요.",
        [
          { text: "그만두기", style: "cancel" },
          {
            text: "보내기",
            onPress: () => {
              void (async () => {
                try {
                  const out = await shareText({
                    text: red.text,
                    fileName: `${exportBaseName(date, dutyLabel)}-전사본${
                      recLabel ? `-${recLabel.replace(/\.[^.]+$/, "")}` : ""
                    }`,
                    format: "txt",
                    title: `${dutyLabel} 전사본`,
                  });
                  if (!out.shared && out.message) setError(out.message);
                  else setNotice("전사본 파일을 만들었어요.");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "공유 창을 열지 못했어요. 다시 눌러 주세요.");
                }
              })();
            },
          },
        ],
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "파일을 만들지 못했어요. 잠시 뒤 다시 해 주세요.");
    } finally {
      setBusy(null);
    }
  }, [date, dutyLabel, recLabel, segments]);

  const runDelete = useCallback(() => {
    Alert.alert(
      "무엇을 지울까요",
      "글자만 지우면 음성 파일은 남아요. 그 녹음은 다시 안 바꾼 상태가 돼요.\n" +
        "음성까지 지우면 글자와 소리가 모두 사라져요. 되살릴 수 없어요.",
      [
        { text: "그만두기", style: "cancel" },
        {
          text: "글자만 지우기",
          onPress: () => {
            void (async () => {
              stopPlayback();
              await deleteTranscript(shiftId, recordings.map((r) => r.id));
              router.back();
            })();
          },
        },
        {
          text: "음성까지 지우기",
          style: "destructive",
          onPress: () => {
            void (async () => {
              stopPlayback();
              const uris = await deleteShiftRecordings(shiftId, recordings.map((r) => r.id));
              const FileSystem = await import("expo-file-system/legacy");
              for (const uri of uris) {
                try {
                  await FileSystem.deleteAsync(uri, { idempotent: true });
                } catch {
                  // 파일이 이미 없어도 기록 삭제는 끝났다.
                }
              }
              router.back();
            })();
          },
        },
      ],
    );
  }, [recordings, router, shiftId, stopPlayback]);

  const listHeader = (
    <View style={{ padding: space.lg, paddingBottom: 0, gap: space.md }}>
      <Card>
        <Heading>
          {date} · {dutyLabel} 전사{recLabel ? ` · ${recLabel}` : ""}
        </Heading>
        <Small>문장 {segments.length}개예요.</Small>
        <Small>문장을 누르면 그 자리부터 들려요.</Small>
        <Small>단어를 길게 누르면 고칠 수 있어요.</Small>
        {segments.length > 0 ? (
          <>
            <Button
              label="전사본 보내기"
              busy={busy === "파일 만드는 중"}
              disabled={busy !== null}
              onPress={() => void runExport()}
            />
          </>
        ) : null}
        {segments.length > 0 || recordings.length > 0 ? (
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {recordings.some((r) => r.file_uri) ? (
              <View style={{ flex: 1 }}>
                <Button
                  label="처음부터 듣기"
                  onPress={() => {
                    const rec = recordings.find((r) => r.file_uri);
                    if (rec) playRecording(rec.id, 0);
                  }}
                />
              </View>
            ) : null}
            <View style={{ flex: 1 }}>
              <Button label="기록 지우기" tone="danger" onPress={runDelete} />
            </View>
          </View>
        ) : null}
        {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
        {notice ? <Small muted={false}>{notice}</Small> : null}
      </Card>

      {segments.length > 0 ? (
        <Card tone={coverage.readyForScoring ? "default" : "warn"}>
          <Heading>누가 말했는지 정하기</Heading>
          <Badge
            text={`${coverage.total}개 중 ${coverage.labeled}개 정함`}
            tone={coverage.readyForScoring ? "ok" : "warn"}
          />
          <Small muted={false}>{coverage.message}</Small>
          <Divider />
          <Small>먼저 아래에서 누구인지 골라요.</Small>
          <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
            {ROLE_OPTIONS.map((opt) => {
              const on = pendingRole === opt.role;
              return (
                <Pressable
                  key={opt.role}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => setPendingRole(opt.role)}
                  style={{
                    paddingVertical: space.xs,
                    paddingHorizontal: space.md,
                    borderRadius: radius.sm,
                    backgroundColor: on ? t.accent : t.surfaceAlt,
                  }}
                >
                  <Text style={{ color: on ? "#fff" : t.text, fontSize: 13, fontWeight: "600" }}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {speakerOrder.length > 0 ? (
            <>
              <>
                <Small>목소리별로 나뉜 전사본이에요.</Small>
                <Small>목소리를 누르면 그 사람 문장이 한 번에 정해져요.</Small>
              </>
              <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
                {speakerOrder.map((sid) => {
                  const count = segments.filter((s) => s.speakerId === sid).length;
                  const role = segments.find((s) => s.speakerId === sid && s.speakerRole)
                    ?.speakerRole;
                  return (
                    <Pressable
                      key={sid}
                      accessibilityRole="button"
                      onPress={() => void assignCluster(sid)}
                      style={{
                        paddingVertical: space.xs,
                        paddingHorizontal: space.md,
                        borderRadius: radius.sm,
                        backgroundColor: t.surfaceAlt,
                        minHeight: 36,
                        justifyContent: "center",
                      }}
                    >
                      <Text style={[type.small, { color: t.text, fontWeight: "600" }]}>
                        {speakerName(sid, speakerOrder)} · {count}문장
                        {role && role !== "unknown" ? ` → ${ROLE_LABELS[role]}` : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : (
            <>
              <Small>문장 위 이름표를 시작과 끝, 두 번 누르면 그 사이가 한 번에 정해져요.</Small>
              <Small>티로는 목소리를 저절로 나눠요. 콜랩은 전사 설정에서 켜요.</Small>
            </>
          )}
          {rangeStart ? (
            <>
              <Small muted={false}>
                시작 문장을 골랐어요. 끝 문장의 이름표를 누르면 &lsquo;
                {ROLE_LABELS[pendingRole]}&rsquo;(으)로 한 번에 정해져요.
              </Small>
              <Button label="고르기 취소" onPress={() => setRangeStart(null)} />
            </>
          ) : null}
        </Card>
      ) : (
        <Card>
          <Body muted>아직 글자로 바뀐 문장이 없어요. 근무 기록 화면에서 녹음을 먼저 바꿔 주세요.</Body>
        </Card>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={segments}
        keyExtractor={(s) => s.id}
        ListHeaderComponent={listHeader}
        contentContainerStyle={{
          // 안전영역 + 바닥 패널 높이 — 내비게이션 바와 패널이 마지막 문장을 가리지 않게.
          paddingBottom: space.bottom + insets.bottom + (playback || wordTarget ? 200 : 0),
        }}
        initialNumToRender={20}
        windowSize={11}
        removeClippedSubviews
        renderItem={({ item, index }) => {
          const prev = index > 0 ? segments[index - 1] : null;
          const speakerKey = (s: TranscriptSegment | null) =>
            s ? `${s.speakerId ?? ""}|${s.speakerRole ?? "unknown"}|${recordingIdOf(s)}` : "·";
          const showHeader = speakerKey(prev) !== speakerKey(item);
          const role = item.speakerRole ?? "unknown";
          const headerLabel = item.speakerId
            ? role !== "unknown"
              ? `${ROLE_LABELS[role]} (${speakerName(item.speakerId, speakerOrder)})`
              : speakerName(item.speakerId, speakerOrder)
            : ROLE_LABELS[role];
          return (
            <SentenceRow
              segment={item}
              showHeader={showHeader}
              headerLabel={headerLabel}
              isRangeStart={rangeStart === item.id}
              isPlaying={playingRowId === item.id}
              onPressHeader={(id) => void toggleRange(id)}
              onPressSentence={playFrom}
              onPressWord={onPressWord}
            />
          );
        }}
      />

      {/* ── 바닥 패널: 재생 막대와 단어 고치기 ── */}
      {playback || wordTarget ? (
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          // 내비게이션 바 위에 뜬다 — 0 이면 재생 버튼이 바에 깔린다.
          bottom: insets.bottom,
          padding: space.md,
          gap: space.sm,
        }}
      >
        {playback ? (
          <View
            style={{
              backgroundColor: t.surfaceRaised,
              borderRadius: radius.lg,
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
              gap: 2,
            }}
          >
            <SeekBar
              positionSec={playback.positionSec}
              durationSec={playback.durationSec}
              onSeek={seekTo}
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={playback.playing ? "잠깐 멈추기" : "듣기"}
                onPress={togglePause}
                style={{ minWidth: TOUCH_MIN, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name={playback.playing ? "pause" : "play"} size={24} color={t.accent} />
              </Pressable>
              <Text style={[type.small, TABULAR, { color: t.text, fontWeight: "600", flex: 1 }]}>
                {formatTime(playback.positionSec)}
                {playback.durationSec > 0 ? ` / ${formatTime(playback.durationSec)}` : ""}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${rate}배속 — 누르면 빨라져요`}
                onPress={cycleRate}
                style={{
                  minWidth: TOUCH_MIN,
                  minHeight: TOUCH_MIN,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.md,
                  backgroundColor: t.surfaceAlt,
                  paddingHorizontal: space.sm,
                }}
              >
                <Text style={[type.small, TABULAR, { color: t.accent, fontWeight: "700" }]}>
                  {String(rate)}×
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="그만 듣기"
                onPress={stopPlayback}
                style={{ minWidth: TOUCH_MIN, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name="close" size={20} color={t.textMuted} />
              </Pressable>
            </View>
          </View>
        ) : null}

        {wordTarget ? (
          <View
            style={{
              backgroundColor: t.surfaceRaised,
              borderRadius: radius.lg,
              padding: space.lg,
              gap: space.sm,
            }}
          >
            <Heading>&ldquo;{wordTarget.word}&rdquo;</Heading>
            <>
              <Small>잘못 적힌 말을 직접 고쳐요.</Small>
              <Small>같은 말을 두 번 고치면 다음부터 알아서 고쳐요.</Small>
            </>
            <TextInput
              value={wordTarget.replacement}
              onChangeText={(replacement) =>
                setWordTarget((w) => (w ? { ...w, replacement } : w))
              }
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                color: t.text,
                backgroundColor: t.surfaceAlt,
                borderRadius: radius.md,
                padding: space.md,
                fontSize: 15,
              }}
            />
            {/* 버튼 셋을 한 줄에 두면 좁은 폰에서 글자가 잘린다. 주 동작만 한 줄. */}
            <Button
              label="이 단어 고치기"
              tone="primary"
              disabled={
                wordTarget.replacement.trim().length === 0 ||
                wordTarget.replacement.trim() === wordTarget.word
              }
              onPress={() => void applyWordFix()}
            />
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button label="단어장에 넣기" onPress={() => void addToMyDict()} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="닫기" onPress={() => setWordTarget(null)} />
              </View>
            </View>
          </View>
        ) : null}
      </View>
      ) : null}
    </View>
  );
}
