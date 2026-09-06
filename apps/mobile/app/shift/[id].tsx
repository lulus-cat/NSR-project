/**
 * 근무 기록 — 녹음을 티로로 넘기는 화면. 이 화면의 일은 셋뿐이다.
 *
 *   1. 티로로 보내기 — 이 근무의 녹음을 티로 앱에 넘긴다. 앱은 전사를 하지
 *      않는다(0.1.8x). 티로가 받아적은 글자는 홈의 '가져오기'로 데려온다.
 *   2. 날짜 고르기 — 어느 날 녹음이 밀렸는지 한눈에. 안 그러면 어디까지
 *      보냈는지 잊는다. '전체 보기'를 켜면 모든 날의 밀린 녹음이 한 목록에 선다.
 *   3. 음성 파일 — 날짜·파일 이름·시각. 들어보고, 잘못 올린 것은 지운다.
 *
 * 전사 **결과**(문장 목록·재생·수정)와 심층 분석은 `/transcript/[id]` 에 있다.
 * 보고서는 학습 탭에서, 병동 분위기(온도)는 듀티표 달력에서 본다 — 여기 있던
 * 두 탭은 뺐다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { DEFAULT_TEMPLATES, type ShiftCode } from "@nsr/core";
import { Badge, Button, Card, Divider, Heading, Small } from "../../src/components/ui";
import { Markdown } from "../../src/components/markdown";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  countSegments,
  deleteShiftRecordings,
  getShiftReportMarkdown,
  getShiftReport,
  listCardsForShift,
  listSegments,
  listConfirmations,
  listRecordings,
  pendingTranscriptions,
  segmentCountsByRecording,
  setRecordingState,
  type ConfirmationRow,
  type RecordingRow,
} from "../../src/db";
import {
  redactForExport,
  shareText,
  type ExportFormat,
  type RedactedText,
} from "../../src/services/export";
import {
  analysisToJson,
  cardsToCsv,
  exportBaseName,
  transcriptToText,
} from "../../src/services/export-bundle";
import { exportNotePdf } from "../../src/services/note-doc";
import { sendShift, serverReady } from "../../src/services/nsr-server";

/** epoch ms → "HH:MM 시작". 이름 없는 녹음 파일을 부를 때. */
function startClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 시작`;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 근무(날짜·듀티) 하나에 묶인 밀린 녹음. */
interface PendingGroup {
  shiftId: string;
  date: string;
  label: string;
  rows: RecordingRow[];
}

/** 밀린 녹음을 근무별로 묶는다. 최근 날짜가 앞으로. */
function groupPending(rows: RecordingRow[]): PendingGroup[] {
  const map = new Map<string, RecordingRow[]>();
  for (const r of rows) {
    const key = r.shift_id;
    if (!key) continue; // 근무에 안 붙은 기록은 날짜를 모른다.
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return [...map.entries()]
    .map(([sid, list]) => {
      const [date, code] = sid.split(":");
      return {
        shiftId: sid,
        date,
        label: DEFAULT_TEMPLATES[(code as ShiftCode) ?? "OTHER"]?.label ?? "근무",
        rows: list.sort((a, b) => a.started_at - b.started_at),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 녹음 상태를 사람이 읽는 배지로. */
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
      return { text: "녹음 중", tone: "muted" };
  }
}

export default function ShiftDetail() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const shiftId = decodeURIComponent(params.id ?? "");
  const [date, code] = shiftId.split(":");

  const [sentenceCount, setSentenceCount] = useState(0);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  /** 기록별 문장 수 — 파일마다 몇 문장인지, 따로 둔 파일에 결과가 있는지. */
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  /** 이 근무를 돌리는 중인 러너 상태. 다른 근무 것이거나 안 돌면 null. */
  const [reportMd, setReportMd] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sendToServer = useCallback(async () => {
    if (sending) return;
    setSending(true);
    setSendNote(null);
    try {
      if (!(await serverReady())) {
        setSendNote("설정에서 서버 주소와 토큰을 먼저 넣어 주세요.");
        return;
      }
      const out = await sendShift(shiftId, (_pct: number, note?: string) => setSendNote(note ?? null));
      setSendNote(`${out.sentences}문장을 보냈어요. 가린 것 ${out.redacted}건이에요.`);
    } catch (e) {
      setSendNote(e instanceof Error ? e.message : "보내지 못했어요. 다시 눌러 주세요.");
    } finally {
      setSending(false);
    }
  }, [sending, shiftId]);

  /** 내보내기 확인 화면이 들고 있어야 할 것 — 무엇을, 어떤 이름으로, 어떤 꼴로. */
  const [preview, setPreview] = useState<{
    label: string;
    fileName: string;
    format: ExportFormat;
    /** 참이면 파일 대신 PDF 로 굽는다. */
    pdf?: boolean;
    redacted: RedactedText;
  } | null>(null);

  // 심층 분석은 전사 결과 화면(`/transcript/[id]`)으로 옮겼다 — 전사가 끝난 자리에서
  // 거는 것이 순서에 맞다. 여기는 그 결과(보고서·확인 필요 목록)를 보는 곳으로 남는다.
  const [confirmations, setConfirmations] = useState<ConfirmationRow[]>([]);

  /** 이 근무만이 아니라 **모든 날**의 밀린 녹음. 어느 날 것이 남았는지 잊지 않게. */
  const [allPending, setAllPending] = useState<RecordingRow[]>([]);
  /** 참이면 음성 파일 목록이 모든 날의 밀린 녹음을 보여준다. */
  const [showAll, setShowAll] = useState(false);

  // 마지막 한 건이 목록에서 빠지면 '전체 보기' 토글이 사라져 빈 카드에 갇혔다.
  useEffect(() => {
    if (allPending.length === 0 && showAll) setShowAll(false);
  }, [allPending.length, showAll]);

  const load = useCallback(async () => {
    const [count, recs, md, cfs, perRec, waiting] = await Promise.all([
      countSegments(shiftId),
      listRecordings(shiftId),
      getShiftReportMarkdown(shiftId),
      listConfirmations(shiftId),
      segmentCountsByRecording(shiftId),
      pendingTranscriptions(),
    ]);
    setSentenceCount(count);
    setRecordings(recs);
    setCounts(perRec);
    setReportMd(md);
    setConfirmations(cfs);
    setAllPending(waiting);
  }, [shiftId]);

  // 전사 결과 화면에서 지우고 돌아오는 길 — 낡지 않게 다시 읽는다.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const pending = recordings.filter((r) => r.state === "recorded");
  const durationSec = recordings.reduce((sum, r) => sum + r.duration_sec, 0);
  // '따로' 둔 파일은 제 전사본으로 간다. 나머지는 한 전사본이다.
  const separateDone = recordings.filter(
    (r) => r.separate === 1 && (counts.get(r.id) ?? 0) > 0,
  );
  const mergedCount = recordings
    .filter((r) => r.separate !== 1)
    .reduce((sum, r) => sum + (counts.get(r.id) ?? 0), 0);
  const dutyLabel = DEFAULT_TEMPLATES[(code as ShiftCode) ?? "OTHER"]?.label ?? "근무";
  const pendingShifts = useMemo(() => groupPending(allPending), [allPending]);
  // 지금 보고 있는 근무는 밀린 게 없어도 칩에 남는다 — 내가 어디에 있는지 보여야 한다.
  const dateChips = useMemo(() => {
    if (pendingShifts.some((g) => g.shiftId === shiftId)) return pendingShifts;
    return [{ shiftId, date, label: dutyLabel, rows: [] as RecordingRow[] }, ...pendingShifts].sort(
      (a, b) => b.date.localeCompare(a.date),
    );
  }, [date, dutyLabel, pendingShifts, shiftId]);

  // 티로 앱으로 보내기 — 앱은 전사를 하지 않는다. 소리를 티로 앱에 넘기고,
  // 티로가 받아적은 뒤 '티로 노트에서 가져오기'로 글자만 데려온다.
  const sendToTiro = useCallback(
    async (rec: RecordingRow) => {
      if (!rec.file_uri) {
        setError("파일이 없어요. 다른 녹음을 골라 주세요.");
        return;
      }
      setError(null);
      // 이 앱에서 가장 위험한 내보내기다 — **소리는 가릴 수 없다.** 목소리에
      // 이름과 진단이 그대로 담겨 있고, 한 번 나가면 되돌릴 수 없다. 글을
      // 내보낼 때는 확인을 받으면서 정작 이쪽에는 아무것도 없었다.
      const ok = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "티로 앱으로 보낼까요",
          "음성은 가릴 수 없어요. 이름과 진단명이 그대로 담긴 채로 티로에 올라가요.",
          [
            { text: "취소", style: "cancel", onPress: () => resolve(false) },
            { text: "보내기", onPress: () => resolve(true) },
          ],
        );
      });
      if (!ok) return;
      setBusy("보내는 중");
      try {
        const Sharing = await import("expo-sharing");
        if (!(await Sharing.isAvailableAsync())) {
          setError("이 폰에서는 보내기를 쓸 수 없어요. 파일 앱에서 티로로 열어 주세요.");
          return;
        }
        await Sharing.shareAsync(rec.file_uri, {
          mimeType: /\.wav$/i.test(rec.file_uri) ? "audio/wav" : "audio/mp4",
          dialogTitle: "티로 앱으로 보내기",
        });
        // 보낸 것으로 적어 둔다. '안 보냄' 목록에서 빠지고, 티로가 다 받아적으면
        // 홈의 '티로 노트에서 글자 가져오기'로 데려온다.
        await setRecordingState(rec.id, "sent");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "보내지 못했어요. 다시 눌러 주세요.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // ── 미리 듣기 — 전사 전에 어떤 녹음인지 귀로 확인한다 ──
  const previewRef = useRef<AudioPlayer | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(
    () => () => {
      try {
        previewRef.current?.remove();
      } catch {
        // 이미 해제됐으면 그만이다.
      }
    },
    [],
  );
  // 파일이 끝까지 재생되면 정지 아이콘을 되돌린다.
  useEffect(() => {
    if (!previewId) return;
    const timer = setInterval(() => {
      const p = previewRef.current;
      if (!p) return;
      try {
        if (p.duration > 0 && !p.playing && p.currentTime >= p.duration - 0.3) {
          setPreviewId(null);
        }
      } catch {
        setPreviewId(null);
      }
    }, 700);
    return () => clearInterval(timer);
  }, [previewId]);

  const stopPreview = useCallback(() => {
    try {
      previewRef.current?.remove();
    } catch {
      // 이미 해제됐으면 그만이다.
    }
    previewRef.current = null;
    setPreviewId(null);
  }, []);

  // 이 화면을 떠나면 맛보기 재생을 멈춘다. 예전에는 전사 결과 화면으로 넘어가도
  // 소리가 계속 흘러나왔다 — 화면이 뒤에 남아 있어 해제가 걸리지 않았다.
  useFocusEffect(useCallback(() => () => stopPreview(), [stopPreview]));

  const togglePreview = useCallback(
    (rec: RecordingRow) => {
      try {
        previewRef.current?.remove();
      } catch {
        // 이전 플레이어 해제 실패는 무시한다.
      }
      previewRef.current = null;
      if (previewId === rec.id) {
        setPreviewId(null);
        return;
      }
      if (!rec.file_uri) return;
      try {
        const player = createAudioPlayer({ uri: rec.file_uri });
        previewRef.current = player;
        player.play();
        setPreviewId(rec.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "소리를 열지 못했어요. 파일이 남아 있는지 확인해 주세요.");
      }
    },
    [previewId],
  );

  /**
   * 이 녹음 하나를 지운다 — 잘못 올린 파일을 전사 전에 여기서 뺀다.
   *
   * 되돌릴 수 없어 한 번 묻는다. 전사된 문장이 딸려 있으면 그 말도 함께 한다.
   * 음성 파일 삭제는 DB 가 돌려준 경로로 이 자리에서 한다.
   */
  const removeRecording = useCallback(
    (rec: RecordingRow) => {
      const sentences = counts.get(rec.id) ?? 0;
      Alert.alert(
        "이 녹음 지울까요?",
        `${rec.label ?? startClock(rec.started_at)} — 음성 파일이 폰에서 사라집니다.` +
          (sentences > 0 ? `\n이 파일로 만든 전사 ${sentences}문장도 함께 지워져요.` : "") +
          "\n한 번 지우면 되살릴 수 없어요.",
        [
          { text: "그만두기", style: "cancel" },
          {
            text: "지우기",
            style: "destructive",
            onPress: () => {
              void (async () => {
                if (previewId === rec.id) stopPreview();
                setError(null);
                try {
                  const uris = await deleteShiftRecordings(rec.shift_id ?? shiftId, [rec.id]);
                  const FileSystem = await import("expo-file-system/legacy");
                  for (const uri of uris) {
                    try {
                      await FileSystem.deleteAsync(uri, { idempotent: true });
                    } catch {
                      // 파일이 이미 없어도 기록 삭제는 끝났다.
                    }
                  }
                } catch (e) {
                  setError(e instanceof Error ? e.message : "녹음을 지우지 못했어요. 잠시 뒤 다시 눌러 주세요.");
                }
                await load();
              })();
            },
          },
        ],
      );
    },
    [counts, load, previewId, shiftId, stopPreview],
  );

  /**
   * 내보낼 것을 골라 확인 화면까지 세운다.
   *
   * 어떤 종류든 나가기 전에 `redactForExport` 한 곳을 지난다 — 가려진 내역을
   * 눈으로 보고 나서야 공유 시트가 열린다.
   */
  const pickExport = useCallback(
    async (kind: "transcript" | "report" | "reportPdf" | "cards" | "analysis") => {
      setError(null);
      setBusy("파일 만드는 중");
      try {
        const base = exportBaseName(date, dutyLabel);
        if (kind === "transcript") {
          const segs = await listSegments(shiftId);
          if (segs.length === 0) {
            setError("아직 글자로 바뀐 문장이 없어요. 녹음부터 바꿔 주세요.");
            return;
          }
          setPreview({
            label: "전사본",
            fileName: `${base}-전사본`,
            format: "txt",
            redacted: await redactForExport(transcriptToText(segs, { date, dutyLabel })),
          });
          return;
        }
        if (kind === "report" || kind === "reportPdf") {
          if (!reportMd) {
            setError("아직 보고서가 없어요. 이 화면에서 보내고 클로드에서 분석해요.");
            return;
          }
          setPreview({
            label: kind === "reportPdf" ? "보고서 PDF" : "보고서",
            fileName: `${base}-보고서`,
            format: "md",
            pdf: kind === "reportPdf",
            redacted: await redactForExport(reportMd),
          });
          return;
        }
        if (kind === "cards") {
          const cards = await listCardsForShift(shiftId);
          if (cards.length === 0) {
            setError("이 근무에서 만든 단어가 없어요. 클로드가 넣으면 생겨요.");
            return;
          }
          setPreview({
            label: `단어장 ${cards.length}장`,
            fileName: `${base}-단어장`,
            format: "csv",
            redacted: await redactForExport(cardsToCsv(cards)),
          });
          return;
        }
        const rep = await getShiftReport(shiftId);
        if (!rep) {
          setError("분석 결과가 없어요. 이 화면에서 보내고 클로드에서 분석해요.");
          return;
        }
        setPreview({
          label: "분석 원본",
          fileName: `${base}-분석원본`,
          format: "json",
          redacted: await redactForExport(
            analysisToJson({
              shiftId,
              date,
              dutyLabel,
              markdown: rep.markdown,
              payload: rep.payload,
              confirmations,
            }),
          ),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "파일을 만들지 못했어요. 잠시 뒤 다시 해 주세요.");
      } finally {
        setBusy(null);
      }
    },
    [confirmations, date, dutyLabel, reportMd, shiftId],
  );

  const doShare = useCallback(async () => {
    if (!preview) return;
    setBusy("보내는 중");
    try {
      if (preview.pdf) {
        await exportNotePdf(preview.fileName, preview.redacted.text);
        setPreview(null);
        return;
      }
      const outcome = await shareText({
        text: preview.redacted.text,
        fileName: preview.fileName,
        format: preview.format,
        title: `${dutyLabel} ${preview.label}`,
      });
      if (!outcome.shared && outcome.message) setError(outcome.message);
      else setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "공유 창을 열지 못했어요. 다시 눌러 주세요.");
    } finally {
      setBusy(null);
    }
  }, [dutyLabel, preview]);

  /**
   * 음성 파일 한 줄. 목록이 둘(이 근무 / 밀린 녹음 전체)이라 한 곳에 모았다.
   * `mine` 이 참이면 이 근무 것이라 문장 수·따로 보기 표시까지 붙인다.
   */
  const recordingRow = (r: RecordingRow, mine: boolean) => {
    const badge = stateBadge(r.state);
    const started = new Date(r.started_at);
    const clock = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
    const mins = Math.round(r.duration_sec / 60);
    const mb = r.size_bytes > 0 ? (r.size_bytes / (1024 * 1024)).toFixed(1) : null;
    const playingThis = previewId === r.id;
    const sentences = counts.get(r.id) ?? 0;
    return (
      <View key={r.id}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            minHeight: TOUCH_MIN,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playingThis ? "그만 듣기" : "미리 듣기"}
            disabled={!r.file_uri}
            onPress={() => togglePreview(r)}
            style={({ pressed }) => ({
              width: TOUCH_MIN,
              height: TOUCH_MIN,
              borderRadius: radius.full,
              backgroundColor: playingThis ? t.accentSoft : t.surfaceAlt,
              alignItems: "center",
              justifyContent: "center",
              opacity: r.file_uri ? 1 : 0.4,
              transform: [{ scale: pressed ? 0.94 : 1 }],
            })}
          >
            <Ionicons name={playingThis ? "stop" : "play"} size={18} color={t.accent} />
          </Pressable>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.body, { color: t.text, fontWeight: "600" }]} numberOfLines={1}>
              {r.label ?? `${clock} 녹음`}
            </Text>
            <Text style={[type.small, TABULAR, { color: t.textMuted, fontWeight: "600" }]}>
              {clock} 시작
              {mins > 0 ? ` · ${mins}분` : ""}
              {mb ? ` · ${mb}MB` : ""}
              {mine && r.separate === 1 ? " · 따로 보기" : ""}
              {mine && sentences > 0 ? ` · ${sentences}문장` : ""}
              {r.file_uri ? "" : " · 파일 없음"}
            </Text>
          </View>
          <Badge text={badge.text} tone={badge.tone} />
          {/* 보냈다고 표시 — 안드로이드는 공유 창에서 무엇을 했는지 안 알려 준다.
              그래서 사람이 누른다. 안 누르면 목록에 그대로 남는다(안전한 쪽). */}
          {r.state === "recorded" && r.file_uri ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="티로에 보냈다고 표시"
              onPress={async () => {
                await setRecordingState(r.id, "sent");
                await load();
              }}
              style={({ pressed }) => ({
                width: TOUCH_MIN,
                height: TOUCH_MIN,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Ionicons name="checkmark-done-outline" size={18} color={t.textMuted} />
            </Pressable>
          ) : null}
          {/* 티로 앱으로 보내기 — 소리를 넘기는 자리 */}
          {r.file_uri ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="티로 앱으로 보내기"
              disabled={busy === "보내는 중"}
              onPress={() => void sendToTiro(r)}
              style={({ pressed }) => ({
                width: TOUCH_MIN,
                height: TOUCH_MIN,
                alignItems: "center",
                justifyContent: "center",
                opacity: busy === "보내는 중" ? 0.3 : pressed ? 0.5 : 1,
              })}
            >
              <Ionicons name="share-outline" size={18} color={t.accent} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="이 녹음 지우기"
            onPress={() => removeRecording(r)}
            style={({ pressed }) => ({
              width: TOUCH_MIN,
              height: TOUCH_MIN,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Ionicons name="trash-outline" size={18} color={t.danger} />
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <ScrollView
      contentContainerStyle={{
        padding: space.lg,
        // 내비게이션 바가 마지막 카드를 가리지 않게 안전영역만큼 띄운다.
        paddingBottom: space.lg + insets.bottom,
        gap: space.md,
      }}
    >
      <Card>
        <Heading>
          {date} · {dutyLabel}
        </Heading>
        <Small>
          녹음 {recordings.length}개 · 총 {Math.round(durationSec / 60)}분 · 문장{" "}
          {sentenceCount}개
        </Small>
        {pending.length > 0 ? (
          <>
            <Small>티로에 안 보낸 녹음이 {pending.length}건 있어요.</Small>
            <Small>보내기(↗)를 누르면 티로 앱이 열려요. 티로가 다 받아적으면</Small>
            <Small>홈에서 글자만 가져와요. 안 보내졌으면 다시 눌러도 돼요.</Small>
          </>
        ) : null}
        {busy ? <Small muted={false}>{busy}…</Small> : null}
        {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
      </Card>

      {/* ── 날짜 고르기 — 어느 날 녹음이 밀렸는지 잊지 않게 ── */}
      <Card tone={allPending.length > 0 ? "warn" : "default"}>
        <Heading>티로에 안 보낸 녹음</Heading>
        <Small>
          {allPending.length > 0
            ? `안 보낸 녹음이 ${allPending.length}건, ${pendingShifts.length}일치 남았어요.`
            : "안 보낸 녹음이 없어요."}
        </Small>
        {allPending.length > 0 ? <Small>날짜를 누르면 그날 근무로 가요.</Small> : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm, paddingVertical: space.xs }}
        >
          {dateChips.map((g) => {
            const on = g.shiftId === shiftId;
            const d = new Date(`${g.date}T00:00:00`);
            return (
              <Pressable
                key={g.shiftId}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  if (on) return;
                  stopPreview();
                  router.replace(`/shift/${encodeURIComponent(g.shiftId)}`);
                }}
                style={{
                  minWidth: 74,
                  paddingVertical: space.sm,
                  paddingHorizontal: space.md,
                  borderRadius: radius.md,
                  backgroundColor: on ? t.accent : t.surfaceAlt,
                  alignItems: "center",
                  gap: 2,
                }}
              >
                <Text style={[type.small, { color: on ? "#FFFFFF" : t.textMuted }]}>
                  {WEEKDAY[d.getDay()]}
                </Text>
                <Text style={[type.body, TABULAR, { color: on ? "#FFFFFF" : t.text, fontWeight: "700" }]}>
                  {d.getMonth() + 1}/{d.getDate()}
                </Text>
                <Text style={[type.caption, { color: on ? "#FFFFFF" : t.textMuted }]}>
                  {g.label}
                  {g.rows.length > 0 ? ` · ${g.rows.length}건` : ""}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {allPending.length > 0 ? (
          <Button
            label={
              showAll
                ? "이 근무만 보기"
                : `전체 보기 ${allPending.length}건`
            }
            onPress={() => setShowAll((v) => !v)}
          />
        ) : null}
      </Card>

      {/* ── 음성 파일 — 날짜·파일 이름·시각. 들어보고, 잘못 올린 것은 지운다 ── */}
      {showAll ? (
        <Card>
          <Heading>안 보낸 녹음 전체</Heading>
          <Small>모든 날의 안 보낸 녹음이에요.</Small>
          <Small>날짜를 눌러 그 근무로 가서 바꿔요.</Small>
          {pendingShifts.map((g) => (
            <View key={g.shiftId} style={{ gap: space.xs }}>
              <Divider />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${g.date} ${g.label} 근무로 가기`}
                onPress={() => {
                  if (g.shiftId === shiftId) {
                    setShowAll(false);
                    return;
                  }
                  stopPreview();
                  router.replace(`/shift/${encodeURIComponent(g.shiftId)}`);
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  minHeight: TOUCH_MIN,
                }}
              >
                <Text style={[type.body, { color: t.text, fontWeight: "700" }]}>
                  {g.date} · {g.label}
                </Text>
                <Small muted={false}>
                  {g.rows.length}건 {g.shiftId === shiftId ? "· 지금 이 근무" : "›"}
                </Small>
              </Pressable>
              {g.rows.map((r) => recordingRow(r, false))}
            </View>
          ))}
        </Card>
      ) : recordings.length > 0 ? (
        <Card>
          <Heading>음성 파일</Heading>
          <Small>재생 버튼으로 먼저 들어 봐요.</Small>
          <Small>잘못 올린 파일은 휴지통으로 지워요.</Small>
          {recordings.map((r, i) => (
            <View key={r.id}>
              {i > 0 ? <Divider /> : null}
              {recordingRow(r, true)}
            </View>
          ))}
        </Card>
      ) : null}

      {/* 전사 결과로 가는 문 — 결과는 전용 화면에서 본다 */}
      {sentenceCount > 0 ? (
        <Card tone="accent">
          <Heading>전사 결과</Heading>
          <Small>문장 {sentenceCount}개가 만들어졌어요.</Small>
          <Small>재생·단어 고치기·분석은 결과 화면에서 해요.</Small>
          {mergedCount > 0 ? (
            <Button
              label={
                separateDone.length > 0 ? `합친 전사본 열기` : "전사본 열기"
              }
              tone="primary"
              onPress={() => router.push(`/transcript/${encodeURIComponent(shiftId)}`)}
            />
          ) : null}
          {separateDone.map((r) => (
            <Button
              key={r.id}
              label={`${r.label ?? startClock(r.started_at)} 열기`}
              tone={mergedCount > 0 ? "default" : "primary"}
              onPress={() =>
                router.push(
                  `/transcript/${encodeURIComponent(shiftId)}?rec=${encodeURIComponent(r.id)}`,
                )
              }
            />
          ))}
        </Card>
      ) : null}

      {/* ── 분석 서버로 보내기 ──
          가린 사본만 올라간다. 올린 뒤 클로드·GPT 에서 "9월 3일 근무 분석해줘"
          하면 그쪽이 읽고 보고서를 써 넣는다. 받아오는 것은 설정에서 한다. */}
      {sentenceCount > 0 && !preview ? (
        <Card>
          <Heading>분석 서버로 보내기</Heading>
          <Small>이름 같은 민감한 말은 가리고 보내요.</Small>
          <Small>보낸 뒤 클로드·GPT 에서 분석해요.</Small>
          {sendNote ? <Small muted={false}>{sendNote}</Small> : null}
          <Button
            label="이 근무 보내기"
            tone="primary"
            busy={sending}
            onPress={() => void sendToServer()}
          />
        </Card>
      ) : null}

      {/* ── 내보내기 — 전사본·보고서·단어장·분석 원본을 파일로 ──
          보고서·단어장·분석 원본은 심층 분석이 만든 것이다. 분석 전에는 눌러도 나올 게
          없어서 아예 감춘다 — 예전엔 분석 버튼 바로 아래에 같이 서 있어 순서가 어긋났다. */}
      {/* 클로드·GPT 가 써 보낸 보고서. 받아 두고 볼 자리가 없어서, 설정에서
          '결과 받기' 를 눌러도 읽을 방법이 없었다. */}
      {reportMd && !preview ? (
        <Card>
          <Heading>근무 보고서</Heading>
          <Small>클로드·GPT 가 읽고 쓴 글이에요.</Small>
          <Divider />
          <Markdown text={reportMd} />
          {confirmations.length > 0 ? (
            <>
              <Divider />
              <Heading>확인 필요</Heading>
              <Small>AI 가 확실하지 않다고 표시한 것들이에요.</Small>
              {confirmations.slice(0, 12).map((c) => (
                <Small key={c.id} muted={false}>
                  · {c.question}
                  {c.candidate ? ` (${c.candidate})` : ""}
                </Small>
              ))}
              {confirmations.length > 12 ? (
                <Small>외 {confirmations.length - 12}건이 더 있어요.</Small>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}

      {sentenceCount > 0 && !preview ? (
        <Card>
          <Heading>파일로 내보내기</Heading>
          <Small>고른 것을 파일로 만들어요.</Small>
          <Small>보내기 전에 가린 개인정보를 보여드려요.</Small>
          <Divider />
          <Button
            label="전사본 보내기"
            busy={busy === "파일 만드는 중"}
            onPress={() => void pickExport("transcript")}
          />
          {reportMd ? (
            <>
              <Button
                label="보고서 보내기"
                onPress={() => void pickExport("report")}
              />
              <Button label="PDF로 보내기" onPress={() => void pickExport("reportPdf")} />
              <Button label="단어장 보내기" onPress={() => void pickExport("cards")} />
              <Button
                label="분석 기록 보내기"
                onPress={() => void pickExport("analysis")}
              />
            </>
          ) : (
            <>
              <Small>보고서와 단어장은 분석을 돌려야 생겨요.</Small>
              <Small>보낸 뒤 클로드·GPT 에서 분석하고, 설정에서 결과를 받아요.</Small>
            </>
          )}
        </Card>
      ) : null}

      {preview ? (
        <Card tone={preview.redacted.masked ? "default" : "warn"}>
          <Heading>이대로 보낼까요</Heading>
          <Badge
            text={preview.redacted.summary}
            tone={preview.redacted.masked ? "ok" : "danger"}
          />
          {preview.redacted.warnings.map((w) => (
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
              <Text style={[type.small, { color: t.text }]}>{preview.redacted.text}</Text>
            </ScrollView>
          </View>
          <Divider />
          <Small>보낸 내용은 받는 곳에 그대로 남아요.</Small>
          <Small>환자 정보가 없는지 마지막으로 확인해요.</Small>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                label="공유 창 열기"
                tone="primary"
                busy={busy === "보내는 중"}
                onPress={() => void doShare()}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="그만두기" onPress={() => setPreview(null)} />
            </View>
          </View>
        </Card>
      ) : null}

    </ScrollView>
  );
}
