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
import { useLocalSearchParams } from "expo-router";
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
  getSetting,
  listRecordings,
  listSegments,
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
import { llmReady, polishTranscriptSegments } from "../../src/services/llm";

const ROLE_OPTIONS: { role: SpeakerRole; label: string }[] = [
  { role: "self", label: "본인" },
  { role: "senior", label: "선배" },
  { role: "doctor", label: "의사" },
  { role: "patient", label: "대상자" },
  { role: "guardian", label: "보호자" },
  { role: "other", label: "기타" },
];

const ROLE_LABELS: Record<SpeakerRole, string> = {
  self: "본인",
  senior: "선배",
  doctor: "의사",
  patient: "대상자",
  guardian: "보호자",
  other: "기타",
  unknown: "미확인",
};

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 세그먼트 id 는 `${recordingId}#s{n}.{m}` 꼴이다 — 앞부분이 재생할 기록이다. */
function recordingIdOf(segment: TranscriptSegment): string {
  return segment.id.split("#s")[0];
}

/** 화자 분리 결과의 라벨(SPEAKER_00 등)을 사람이 부를 이름으로. */
function speakerName(speakerId: string, order: string[]): string {
  const i = order.indexOf(speakerId);
  return `화자 ${i >= 0 ? i + 1 : "?"}`;
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
          accessibilityLabel={`${headerLabel} — 눌러서 화자 구간 지정`}
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
        accessibilityLabel="누르면 이 시점부터 재생"
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
        {/* 발언 시점 — 매 줄에 붙는다. 글자수 비례 추정이라 "그 근처"용이다. */}
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
                  accessibilityLabel={`${word} — 길게 눌러 수정`}
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

export default function TranscriptView() {
  const t = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const shiftId = decodeURIComponent(params.id ?? "");
  const [date, code] = shiftId.split(":");
  const dutyLabel = DEFAULT_TEMPLATES[(code as ShiftCode) ?? "OTHER"]?.label ?? "근무";

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [segs, recs] = await Promise.all([listSegments(shiftId), listRecordings(shiftId)]);
    setSegments(segs);
    setRecordings(recs);
  }, [shiftId]);

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
  const [playback, setPlayback] = useState<
    { recordingId: string; positionSec: number; playing: boolean } | null
  >(null);

  useEffect(() => {
    const timer = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        if (pendingSeekRef.current !== null && p.duration > 0) {
          const target = pendingSeekRef.current;
          pendingSeekRef.current = null;
          if (Math.abs(p.currentTime - target) > 2) void p.seekTo(target);
        }
        setPlayback((prev) => {
          if (!prev) return prev;
          if (
            Math.floor(prev.positionSec) === Math.floor(p.currentTime) &&
            prev.playing === p.playing
          ) {
            return prev;
          }
          return { ...prev, positionSec: p.currentTime, playing: p.playing };
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

  const playFrom = useCallback(
    (segment: TranscriptSegment) => {
      const recId = recordingIdOf(segment);
      const rec = recordings.find((r) => r.id === recId);
      if (!rec?.file_uri) {
        setNotice("이 문장의 기록 파일이 기기에 없어 재생할 수 없습니다.");
        return;
      }
      try {
        if (playerRef.current && playback?.recordingId === recId) {
          pendingSeekRef.current = null;
          void playerRef.current.seekTo(segment.startSec);
          playerRef.current.play();
        } else {
          try {
            playerRef.current?.remove();
          } catch {
            // 이전 플레이어 해제 실패는 재생을 막지 않는다.
          }
          const player = createAudioPlayer({ uri: rec.file_uri });
          playerRef.current = player;
          pendingSeekRef.current = segment.startSec;
          void player.seekTo(segment.startSec);
          player.play();
        }
        setPlayback({ recordingId: recId, positionSec: segment.startSec, playing: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "재생하지 못했습니다.");
      }
    },
    [playback?.recordingId, recordings],
  );

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
  }, [segments, wordTarget]);

  const addToMyDict = useCallback(async () => {
    if (!wordTarget) return;
    const surface = wordTarget.word.trim();
    if (surface.length < 2) {
      setError("2자 이상 입력해야 합니다.");
      return;
    }
    await saveUserTerm({
      id: `user-${Date.now().toString(36)}`,
      ko: surface,
      aliases: [],
      category: "workflow",
      definition: "병동 전용 용어입니다. 의미를 입력하십시오.",
    });
    setWordTarget(null);
    setError(null);
    setNotice(`'${surface}'${josa(surface, "을")} 사전에 넣었습니다. 세부 뜻은 나중에 사전에서 적어주십시오.`);
  }, [wordTarget]);

  const onPressWord = useCallback((segmentId: string, word: string) => {
    setWordTarget({ segmentId, word, replacement: word });
  }, []);

  // ── AI 다듬기 — Whisper 가 놓친 문맥 교정을 LLM 이 맡는다 ──
  const runPolish = useCallback(async () => {
    const ready = await llmReady();
    if (!ready.ok) {
      setError(ready.reason ?? "설정 → 보조 기능에서 AI 를 먼저 연결하십시오.");
      return;
    }
    Alert.alert(
      "AI로 다듬기",
      "전사본이 개인정보를 가린 상태로 설정한 AI 서버에 전송됩니다. " +
        "개인정보가 있는 문장은 다듬지 않고 그대로 둡니다. 원문 기록은 보존됩니다.",
      [
        { text: "취소", style: "cancel" },
        {
          text: "보내기",
          onPress: () => {
            void (async () => {
              setError(null);
              setBusy("AI 다듬는 중");
              try {
                const lexicon = await loadLexicon();
                const changed = await polishTranscriptSegments(
                  segments.map((s) => ({ id: s.id, text: s.text })),
                  lexicon,
                  (done, total) => setBusy(`AI 다듬는 중 ${done}/${total} 문장`),
                );
                for (const [id, text] of changed) {
                  await updateSegmentText(id, text);
                }
                setSegments((prev) =>
                  prev.map((s) => (changed.has(s.id) ? { ...s, text: changed.get(s.id)! } : s)),
                );
                setNotice(
                  changed.size > 0
                    ? `${changed.size}개 문장을 다듬었습니다. 각 문장의 '원문'과 비교할 수 있습니다.`
                    : "다듬을 문장이 없었습니다.",
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : "AI 다듬기에 실패했습니다.");
              } finally {
                setBusy(null);
              }
            })();
          },
        },
      ],
    );
  }, [segments]);

  const listHeader = (
    <View style={{ padding: space.lg, paddingBottom: 0, gap: space.md }}>
      <Card>
        <Heading>
          {date} · {dutyLabel} 전사
        </Heading>
        <Small>
          {segments.length}문장 · 문장을 누르면 그 시점부터 재생, 단어를 길게 누르면 수정.
        </Small>
        {segments.length > 0 ? (
          <Button
            label={busy?.startsWith("AI") ? busy : "AI로 다듬기"}
            busy={busy?.startsWith("AI") ?? false}
            disabled={busy !== null}
            onPress={() => void runPolish()}
          />
        ) : null}
        {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
        {notice ? <Small muted={false}>{notice}</Small> : null}
      </Card>

      {segments.length > 0 ? (
        <Card tone={coverage.readyForScoring ? "default" : "warn"}>
          <Heading>
  발언자 지정
</Heading>
          <Badge
            text={`${coverage.total}개 중 ${coverage.labeled}개 지정`}
            tone={coverage.readyForScoring ? "ok" : "warn"}
          />
          <Small muted={false}>{coverage.message}</Small>
          <Divider />
          <Small>먼저 아래에서 역할을 고른 뒤 —</Small>
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
              <Small>
                화자 분리가 켜져 있던 전사입니다. 화자를 누르면 그 화자의 모든 문장이 위에서
                고른 역할로 한 번에 지정됩니다.
              </Small>
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
            <Small>
              <Text style={{ fontWeight: "700" }}>문장 위 배지(머리줄)</Text>를 시작과 끝 두 번
              누르면 그 사이가 일괄 지정됩니다. 자동 화자 분리는 전사 설정의 콜랩에서 켤 수
              있습니다.
            </Small>
          )}
          {rangeStart ? (
            <>
              <Small muted={false}>
                시작 문장이 선택되었습니다. 끝 문장의 배지를 누르면 &lsquo;
                {ROLE_LABELS[pendingRole]}&rsquo;(으)로 일괄 지정됩니다.
              </Small>
              <Button label="구간 지정 취소" onPress={() => setRangeStart(null)} />
            </>
          ) : null}
        </Card>
      ) : (
        <Card>
          <Body muted>전사 내용이 없습니다. 근무 기록 화면에서 먼저 전사를 실행하십시오.</Body>
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
          paddingBottom: space.bottom + (playback || wordTarget ? 180 : 0),
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
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: space.md, gap: space.sm }}>
        {playback ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              backgroundColor: t.surfaceRaised,
              borderRadius: radius.lg,
              paddingHorizontal: space.lg,
              minHeight: TOUCH_MIN + 8,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playback.playing ? "일시정지" : "재생"}
              onPress={togglePause}
              style={{ minWidth: 40, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name={playback.playing ? "pause" : "play"} size={22} color={t.accent} />
            </Pressable>
            <Text style={[type.small, TABULAR, { color: t.text, fontWeight: "600", flex: 1 }]}>
              {formatTime(playback.positionSec)} · 기록 재생 중
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="재생 종료"
              onPress={stopPlayback}
              style={{ minWidth: 40, minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="close" size={20} color={t.textMuted} />
            </Pressable>
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
            <Small>
              전사 오류를 직접 고치십시오. 같은 교정이 2번 쌓이면 다음부터는 자동으로 고쳐집니다.
            </Small>
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
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="고치기"
                  tone="primary"
                  disabled={
                    wordTarget.replacement.trim().length === 0 ||
                    wordTarget.replacement.trim() === wordTarget.word
                  }
                  onPress={() => void applyWordFix()}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="내 사전에 추가" onPress={() => void addToMyDict()} />
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
