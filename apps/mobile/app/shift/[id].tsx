import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, TextInput, View } from "react-native";
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
  type TaeumScore,
  type TranscriptSegment,
  type ShiftCode,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../../src/components/ui";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  getShiftReportMarkdown,
  getTaeumScore,
  listRecordings,
  listSegments,
  loadCorrectionMemory,
  saveCorrectionMemory,
  saveUserTerm,
  setSpeakerRole,
  setSpeakerRoleForCluster,
  updateSegmentText,
  type RecordingRow,
} from "../../src/db";
import { finalizeShift } from "../../src/services/asr";
import {
  runnerState,
  startTranscription,
  subscribeRunner,
  type RunnerState,
} from "../../src/services/transcribe-runner";
import { redactForExport, shareText, type RedactedText } from "../../src/services/export";

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

type Tab = "transcript" | "report" | "environment";

/**
 * 전사 한 줄 — 다글로식.
 *
 * 화자가 바뀌는 줄에만 화자·시각 머리줄을 얹고, 본문은 어절 단위 Pressable 로
 * 편다(한국어는 조사가 붙어 "폴리를"이 한 덩어리라, 글자 단위보다 어절이 짚기
 * 쉽다). 손가락 문법은 세 가지다:
 *   문장 누르기       → 그 시점부터 재생
 *   머리줄(배지) 누르기 → 화자 구간 지정의 시작/끝
 *   단어 길게 누르기   → 고치기·사전 등록
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
          <Text style={[type.caption, TABULAR, { color: t.textMuted }]}>
            {formatTime(segment.startSec)}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="누르면 이 시점부터 재생"
        onPress={() => onPressSentence(segment)}
        style={{
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
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          {isPlaying ? (
            <Ionicons
              name="volume-high"
              size={13}
              color={t.accent}
              style={{ marginRight: 5 }}
            />
          ) : null}
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
      </Pressable>
    </View>
  );
});

export default function ShiftDetail() {
  const t = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const shiftId = decodeURIComponent(params.id ?? "");
  const [date, code] = shiftId.split(":");

  const [tab, setTab] = useState<Tab>("transcript");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [taeum, setTaeum] = useState<TaeumScore | null>(null);
  const [reportMd, setReportMd] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RedactedText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [segs, recs, score, md] = await Promise.all([
      listSegments(shiftId),
      listRecordings(shiftId),
      getTaeumScore(shiftId),
      getShiftReportMarkdown(shiftId),
    ]);
    setSegments(segs);
    setRecordings(recs);
    setTaeum(score);
    setReportMd(md);
  }, [shiftId]);

  useEffect(() => {
    void load();
  }, [load]);

  const coverage = useMemo(() => speakerCoverage(segments), [segments]);

  /** 화자 분리 결과가 있으면 등장 순서대로. 역할 일괄 지정의 단위다. */
  const speakerOrder = useMemo(() => {
    const order: string[] = [];
    for (const s of segments) {
      if (s.speakerId && !order.includes(s.speakerId)) order.push(s.speakerId);
    }
    return order;
  }, [segments]);

  /** 구간 지정 중일 때의 시작 문장 id. 두 번째를 누르면 그 사이가 지정된다. */
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<SpeakerRole>("senior");
  /** 단어를 길게 눌렀을 때 뜨는 패널. */
  const [wordTarget, setWordTarget] = useState<
    { segmentId: string; word: string; replacement: string } | null
  >(null);

  // ── 재생 ──────────────────────────────────────────────
  // 문장을 누르면 그 기록 파일을 그 시점부터 들려준다. 전사가 미덥지 않은
  // 문장은 눈이 아니라 귀로 확인하는 게 빠르다.
  const playerRef = useRef<AudioPlayer | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const [playback, setPlayback] = useState<
    { recordingId: string; positionSec: number; playing: boolean } | null
  >(null);

  useEffect(() => {
    // 위치는 0.5초마다 읽는다. 이벤트 API 보다 단순하고, 하이라이트에는 충분하다.
    const timer = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        // 파일이 열리기 전에 넣은 seek 는 무시됐을 수 있다 — 열린 뒤 한 번 민다.
        // 이미 목표 근처면 다시 밀지 않는다(첫 seek 가 성공했는데 되감으면 안 된다).
        if (pendingSeekRef.current !== null && p.duration > 0) {
          const target = pendingSeekRef.current;
          pendingSeekRef.current = null;
          if (Math.abs(p.currentTime - target) > 2) void p.seekTo(target);
        }
        // 표시는 초 단위다. 같은 초 안에서는 상태를 안 바꿔 목록 재렌더를 아낀다.
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
        // 플레이어가 해제된 직후의 틱 — 다음 틱에서 정리된다.
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      // 화면을 떠나면 소리도 끝난다.
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
      // 이미 해제된 플레이어 — 무시한다.
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
          // 파일이 열리기 전의 seek 는 무시될 수 있다 — 틱이 열림을 보고 다시 민다.
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

  /** 지금 소리 나는 문장. 같은 기록 안에서 시간이 걸치는 첫 문장이다. */
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

  const pending = recordings.filter((r) => r.state === "recorded");
  const durationSec = recordings.reduce((sum, r) => sum + r.duration_sec, 0);
  const dutyLabel = DEFAULT_TEMPLATES[(code as ShiftCode) ?? "OTHER"]?.label ?? "근무";

  const [runnerBusy, setRunnerBusy] = useState(false);
  useEffect(() => {
    const apply = (s: RunnerState) => {
      setRunnerBusy(s.running);
      if (s.shiftId !== shiftId) return;
      if (s.running) {
        setBusy(
          `전사 중 ${s.percent}% (${s.fileIndex}/${s.fileCount})${s.note ? ` · ${s.note}` : ""}`,
        );
      } else {
        setBusy(null);
        if (s.error) setError(s.error);
        if (s.completedAt) void load();
      }
    };
    apply(runnerState());
    return subscribeRunner(apply);
  }, [shiftId, load]);

  const runTranscription = useCallback(() => {
    setError(null);
    if (!startTranscription(shiftId, pending)) {
      setError("이미 전사가 진행 중이거나 전사할 기록이 없습니다.");
    }
  }, [shiftId, pending]);

  const runFinalize = useCallback(async () => {
    setError(null);
    setBusy("정리 중");
    try {
      await finalizeShift({ shiftId, date: date ?? "", dutyLabel, recordedSec: durationSec });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "정리에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }, [date, durationSec, dutyLabel, load, shiftId]);

  const prepareExport = useCallback(async () => {
    if (!reportMd) return;
    setError(null);
    setPreview(await redactForExport(reportMd));
  }, [reportMd]);

  const doShare = useCallback(async () => {
    if (!preview) return;
    setBusy("공유 여는 중");
    try {
      const outcome = await shareText({
        text: preview.text,
        fileName: `${date ?? "근무"}-${code ?? ""}-보고서`,
        title: `${dutyLabel} 보고서 내보내기`,
      });
      if (!outcome.shared && outcome.message) setError(outcome.message);
      else setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "공유하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }, [code, date, dutyLabel, preview]);

  /** 머리줄(배지)을 눌러 구간을 지정한다. 첫 누름 = 시작, 두 번째 = 끝. */
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

  /** 화자 분리 결과(화자 N) 전체에 역할을 준다 — 분리가 있으면 이쪽이 제일 빠르다. */
  const assignCluster = useCallback(
    async (speakerId: string) => {
      await setSpeakerRoleForCluster(shiftId, speakerId, pendingRole);
      setSegments((prev) =>
        prev.map((s) => (s.speakerId === speakerId ? { ...s, speakerRole: pendingRole } : s)),
      );
    },
    [pendingRole, shiftId],
  );

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
    setBusy(null);
    setNotice(`'${surface}'${josa(surface, "을")} 사전에 넣었습니다. 세부 뜻은 나중에 사전에서 적어주십시오.`);
  }, [wordTarget]);

  const onPressWord = useCallback((segmentId: string, word: string) => {
    setWordTarget({ segmentId, word, replacement: word });
  }, []);

  /**
   * 목록 머리 — 전사 행 이외의 모든 것.
   *
   * 수천 문장을 그리려면 목록이 가상화(FlatList)되어야 한다. 3시간 통짜
   * 기록을 ScrollView 로 다 그리다 앱이 "응답하지 않음"으로 죽은 실사고가
   * 있다. 그래서 화면 전체가 FlatList 하나이고, 나머지 카드는 머리에 얹는다.
   */
  const listHeader = (
    <View style={{ padding: space.lg, paddingBottom: 0, gap: space.md }}>
      <Card>
        <Heading>
          {date} · {dutyLabel}
        </Heading>
        <Small>
          기록 {recordings.length}개 · 총 {Math.round(durationSec / 60)}분 · 전사 세그먼트{" "}
          {segments.length}개
        </Small>
        {pending.length > 0 ? (
          <Button
            label={
              busy?.startsWith("전사")
                ? busy
                : runnerBusy
                  ? "다른 근무 전사 중"
                  : `미전사 기록 ${pending.length}건 전사하기`
            }
            tone="primary"
            busy={busy?.startsWith("전사") ?? false}
            disabled={runnerBusy}
            onPress={() => void runTranscription()}
          />
        ) : null}
        {segments.length > 0 ? (
          <Button
            label={reportMd ? "다시 정리하기" : "카드·보고서 만들기"}
            busy={busy === "정리 중"}
            onPress={() => void runFinalize()}
          />
        ) : null}
        {busy ? <Small muted={false}>{busy}…</Small> : null}
        {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
        {notice ? <Small muted={false}>{notice}</Small> : null}
      </Card>

      {/* 화자 지정 — 태움 판단의 전제 */}
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
          <Small>
            먼저 아래에서 역할을 고른 뒤 —
          </Small>
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
              전사 탭에서 <Text style={{ fontWeight: "700" }}>문장 위 배지(머리줄)</Text>를
              시작과 끝 두 번 누르면 그 사이가 일괄 지정됩니다. 자동 화자 분리는 전사
              설정의 콜랩에서 켤 수 있습니다.
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
      ) : null}

      {/* 탭 */}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {(
          [
            ["transcript", "전사"],
            ["report", "보고서"],
            ["environment", "근무 환경"],
          ] as [Tab, string][]
        ).map(([key, label]) => {
          const on = tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => setTab(key)}
              style={{
                paddingVertical: space.sm,
                paddingHorizontal: space.lg,
                borderRadius: radius.sm,
                backgroundColor: on ? t.accent : t.surfaceAlt,
              }}
            >
              <Text style={{ color: on ? "#fff" : t.text, fontWeight: "600", fontSize: 14 }}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "transcript" ? (
        segments.length === 0 ? (
          <Card>
            <Body muted>

  전사 내용이 없습니다. 먼저 전사를 실행해 주십시오.
</Body>
          </Card>
        ) : (
          <Card>
            <Small>
              <Text style={{ fontWeight: "700" }}>문장을 누르면 그 시점부터 재생</Text>됩니다.
              단어를 길게 누르면 고치거나 사전에 넣고, 문장 위 배지를 누르면 화자 구간을
              지정합니다.
            </Small>
          </Card>
        )
      ) : null}

      {tab === "report" ? (
        <>
          <Card>
            {reportMd ? (
              <Text style={[type.body, { color: t.text }]}>{reportMd}</Text>
            ) : (
              <Body muted>

  보고서가 없습니다. 전사를 마친 뒤 ‘카드·보고서 만들기’를 실행하십시오.
</Body>
            )}
          </Card>

          {reportMd && !preview ? (
            <Card>
              <Heading>내보내기</Heading>
              <Small>

  이름과 연락처 등 가려진 개인정보 내역을 꼭 확인한 뒤 보내십시오.
</Small>
              <Button label="내보낼 내용 확인" onPress={() => void prepareExport()} />
            </Card>
          ) : null}

          {preview ? (
            <Card tone={preview.masked ? "default" : "warn"}>
              <Heading>
  위 내용으로 내보냅니다
</Heading>
              <Badge
                text={preview.summary}
                tone={preview.masked ? "ok" : "danger"}
              />
              {preview.warnings.map((w) => (
                <Small key={w.reason} muted={false}>
                  ⚠ {w.message}
                </Small>
              ))}
              <Divider />
              <View
                style={{
                  backgroundColor: t.surfaceAlt,
                  borderRadius: radius.md,
                  padding: space.md,
                  maxHeight: 320,
                }}
              >
                <ScrollView nestedScrollEnabled>
                  <Text style={[type.small, { color: t.text }]}>{preview.text}</Text>
                </ScrollView>
              </View>
              <Divider />
              <Small>

  수신자와 메신저 서버에 기록이 남습니다. 개인정보가 없는지 마지막으로 확인하십시오.
</Small>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="보내기"
                    tone="primary"
                    busy={busy === "공유 여는 중"}
                    onPress={() => void doShare()}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label="취소" onPress={() => setPreview(null)} />
                </View>
              </View>
            </Card>
          ) : null}
        </>
      ) : null}

      {tab === "environment" ? (
        taeum ? (
          <>
            <Card>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "baseline",
                  gap: space.sm,
                }}
              >
                <Text style={[type.title, { color: t.text }]}>{taeum.score}</Text>
                <Badge
                  text={taeum.levelLabel}
                  tone={
                    taeum.level === "severe"
                      ? "danger"
                      : taeum.level === "caution"
                        ? "warn"
                        : taeum.level === "watch"
                          ? "muted"
                          : "ok"
                  }
                />
              </View>
              <Small>{taeum.disclaimer}</Small>
            </Card>

            {taeum.events.length > 0 ? (
              <Card>
                <Heading>기록된 발언</Heading>
                <Small>
  수치보다 실제 인용문이 중요합니다.
</Small>
                {taeum.events.map((e, i) => (
                  <View key={`${e.segmentId}-${i}`} style={{ gap: space.xs, paddingVertical: space.sm }}>
                    <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                      <Badge text={e.categoryLabel} tone="warn" />
                      <Small>{formatTime(e.atSec)}</Small>
                    </View>
                    <Body>&ldquo;{e.quote}&rdquo;</Body>
                    <Divider />
                  </View>
                ))}
              </Card>
            ) : (
              <Card>
                <Body muted>
  감지된 특이 발언이 없습니다.
</Body>
                <Small>

  아무 문제 없다는 뜻이 아닙니다. 텍스트에는 어조나 맥락이 담기지 않습니다.
</Small>
              </Card>
            )}

            {taeum.patientAggression.length > 0 ? (
              <Card>
                <Heading>응대 중 폭언</Heading>
                <Small>

  응대 중 폭언은 산업안전보건법상 보호 대상입니다. 병원 보안 절차에 따라 대응하십시오.
</Small>
                {taeum.patientAggression.map((e, i) => (
                  <View key={`${e.segmentId}-p${i}`} style={{ gap: space.xs, paddingVertical: space.sm }}>
                    <Small>{formatTime(e.atSec)}</Small>
                    <Body>&ldquo;{e.quote}&rdquo;</Body>
                    <Divider />
                  </View>
                ))}
              </Card>
            ) : null}

            <Card>
              <Heading>참고</Heading>
              <Small>

  근로기준법은 직장 내 괴롭힘과 신고자에 대한 불이익 처우를 엄격히 금지합니다.
</Small>
              <Small>
                상담·신고: 소속 병원 고충처리 부서 · 대한간호협회 간호사 인권센터 ·
                고용노동부 노동포털
              </Small>
            </Card>
          </>
        ) : (
          <Card>
            <Body muted>

  화자를 지정한 후 ‘카드·보고서 만들기’를 누르십시오.
</Body>
          </Card>
        )
      ) : null}
    </View>
  );

  const rows = tab === "transcript" ? segments : [];

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={rows}
        keyExtractor={(s) => s.id}
        ListHeaderComponent={listHeader}
        contentContainerStyle={{
          paddingBottom: space.bottom + (playback || wordTarget ? 180 : 0),
        }}
        initialNumToRender={20}
        windowSize={11}
        removeClippedSubviews
        renderItem={({ item, index }) => {
          const prev = index > 0 ? rows[index - 1] : null;
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

      {/* ── 바닥 패널: 재생 막대와 단어 고치기. 목록 위에 뜬다 ──
          비어 있을 때는 아예 안 그린다 — 투명한 패널이 목록 끝의 터치를 먹는다. */}
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
