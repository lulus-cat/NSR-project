/**
 * 근무 기록 — 전사를 돌리고, 보고서와 근무 환경을 보는 화면.
 *
 * 전사 **결과**(문장 목록·재생·수정)는 여기 없다. `/transcript/[id]` 로
 * 분리했다 — 결과와 실행이 한 화면에 있으면 전사가 끝나는 순간 수천
 * 문장이 이 화면에 쏟아져 모든 것이 무거워진다. 여기는 가볍게 남는다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import {
  DEFAULT_TEMPLATES,
  type TaeumScore,
  type ShiftCode,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../../src/components/ui";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  countSegments,
  getPipelineJob,
  getShiftReportMarkdown,
  getTaeumScore,
  listConfirmations,
  listRecordings,
  type ConfirmationRow,
  type RecordingRow,
} from "../../src/db";
import { finalizeShift } from "../../src/services/asr";
import {
  checkDeepAnalysis,
  describeStage,
  pipelineReady,
  startDeepAnalysis,
  type PipelineState,
} from "../../src/services/pipeline";
import {
  runnerState,
  startTranscription,
  subscribeRunner,
  type RunnerState,
} from "../../src/services/transcribe-runner";
import { redactForExport, shareText, type RedactedText } from "../../src/services/export";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 녹음 상태를 사람이 읽는 배지로. */
function stateBadge(state: string): { text: string; tone: "ok" | "muted" | "warn" } {
  switch (state) {
    case "recorded":
      return { text: "미전사", tone: "warn" };
    case "transcribing":
      return { text: "전사 중", tone: "muted" };
    case "transcribed":
      return { text: "전사됨", tone: "ok" };
    case "discarded":
      return { text: "버림", tone: "muted" };
    default:
      return { text: "녹음 중", tone: "muted" };
  }
}

type Tab = "report" | "environment";

export default function ShiftDetail() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const shiftId = decodeURIComponent(params.id ?? "");
  const [date, code] = shiftId.split(":");

  const [tab, setTab] = useState<Tab>("report");
  const [sentenceCount, setSentenceCount] = useState(0);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [taeum, setTaeum] = useState<TaeumScore | null>(null);
  const [reportMd, setReportMd] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RedactedText | null>(null);

  // ── 심층 분석 (3a→3b→4 파이프라인) ──
  const [deep, setDeep] = useState<PipelineState | null>(null);
  const [deepGate, setDeepGate] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [deepBusy, setDeepBusy] = useState(false);
  const [confirmations, setConfirmations] = useState<ConfirmationRow[]>([]);

  const load = useCallback(async () => {
    const [count, recs, score, md, job, gate, cfs] = await Promise.all([
      countSegments(shiftId),
      listRecordings(shiftId),
      getTaeumScore(shiftId),
      getShiftReportMarkdown(shiftId),
      getPipelineJob(shiftId),
      pipelineReady(),
      listConfirmations(shiftId),
    ]);
    setSentenceCount(count);
    setRecordings(recs);
    setTaeum(score);
    setReportMd(md);
    setDeep(describeStage(job));
    setDeepGate(gate);
    setConfirmations(cfs);
  }, [shiftId]);

  // 배치가 도는 동안 화면이 열려 있으면 30초마다 한 걸음씩 민다.
  useEffect(() => {
    if (!deep || !["3a", "3b", "4"].includes(deep.stage)) return;
    const timer = setInterval(() => {
      void (async () => {
        const next = await checkDeepAnalysis(shiftId);
        setDeep(next);
        if (next.stage === "done") void load();
      })();
    }, 30000);
    return () => clearInterval(timer);
  }, [deep, load, shiftId]);

  const runDeep = useCallback(async () => {
    setDeepBusy(true);
    setError(null);
    try {
      setDeep(await startDeepAnalysis(shiftId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "심층 분석을 시작하지 못했습니다.");
    } finally {
      setDeepBusy(false);
    }
  }, [shiftId]);

  const pokeDeep = useCallback(async () => {
    setDeepBusy(true);
    try {
      const next = await checkDeepAnalysis(shiftId);
      setDeep(next);
      if (next.stage === "done") await load();
    } finally {
      setDeepBusy(false);
    }
  }, [load, shiftId]);

  // 전사 결과 화면에서 지우고 돌아오는 길 — 문장 수·상태가 낡지 않게 다시 읽는다.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

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
        setError(e instanceof Error ? e.message : "재생하지 못했습니다.");
      }
    },
    [previewId],
  );

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
          기록 {recordings.length}개 · 총 {Math.round(durationSec / 60)}분 · 전사{" "}
          {sentenceCount}문장
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
        {busy ? <Small muted={false}>{busy}…</Small> : null}
        {error ? <Text style={[type.small, { color: t.danger }]}>{error}</Text> : null}
      </Card>

      {/* ── 음성 파일 — 건수 뒤에 숨어 있던 녹음이 파일별로 보인다 ── */}
      {recordings.length > 0 ? (
        <Card>
          <Heading>음성 파일</Heading>
          <Small>
            이 근무에서 녹음된 파일입니다. 재생 단추로 전사 전에 미리 들어볼 수 있습니다.
          </Small>
          {recordings.map((r, i) => {
            const badge = stateBadge(r.state);
            const started = new Date(r.started_at);
            const clock = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
            const mins = Math.round(r.duration_sec / 60);
            const mb = r.size_bytes > 0 ? (r.size_bytes / (1024 * 1024)).toFixed(1) : null;
            const playingThis = previewId === r.id;
            return (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
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
                    accessibilityLabel={playingThis ? "미리 듣기 정지" : "미리 듣기"}
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
                    <Text style={[type.body, { color: t.text, fontWeight: "600" }]}>
                      {clock} 시작{mins > 0 ? ` · ${mins}분` : ""}
                    </Text>
                    <Text style={[type.small, TABULAR, { color: t.textMuted, fontWeight: "600" }]}>
                      {mb ? `${mb}MB` : "크기 미확인"}
                      {r.file_uri ? "" : " · 파일 없음"}
                    </Text>
                  </View>
                  <Badge text={badge.text} tone={badge.tone} />
                </View>
              </View>
            );
          })}
        </Card>
      ) : null}

      {/* 전사 결과로 가는 문 — 결과는 전용 화면에서 본다 */}
      {sentenceCount > 0 ? (
        <Card tone="accent">
          <Heading>전사 결과</Heading>
          <Small>
            {sentenceCount}문장 · 문장별 재생, 화자 지정, 단어 수정, AI 다듬기는 결과
            화면에서 합니다.
          </Small>
          <Button
            label="전사 결과 열기"
            tone="primary"
            onPress={() => router.push(`/transcript/${encodeURIComponent(shiftId)}`)}
          />
          <Button
            label={reportMd ? "다시 정리하기" : "카드·보고서 만들기"}
            busy={busy === "정리 중"}
            onPress={() => void runFinalize()}
          />
        </Card>
      ) : null}

      {/* ── 심층 분석 — Claude 추출·조사 + Gemini 보고서. 배치라 몇 분~몇 십 분 ── */}
      {sentenceCount > 0 ? (
        <Card>
          <Heading>심층 분석 (AI 3단)</Heading>
          <Small>
            Claude Opus 5 가 교정·판독불가·교육포인트를 추출하고, Claude Fable 5 가 웹
            검색으로 검증하고, Gemini 가 보고서·카드로 정리합니다. 배치 처리라 몇 분에서
            몇 십 분 걸립니다 — 화면을 닫아도 진행되고, 다시 열어 이어받습니다.
          </Small>
          {deepGate && !deepGate.ok ? (
            <Body muted>{deepGate.reason}</Body>
          ) : deep && deep.stage !== "idle" ? (
            <>
              <Badge
                text={
                  deep.stage === "done"
                    ? "완료"
                    : deep.stage === "error"
                      ? "실패"
                      : `진행 중 · ${deep.stage} 단계`
                }
                tone={deep.stage === "done" ? "ok" : deep.stage === "error" ? "danger" : "warn"}
              />
              <Small muted={false}>{deep.detail}</Small>
              {deep.error ? <Text style={[type.small, { color: t.danger }]}>{deep.error}</Text> : null}
              {["3a", "3b", "4"].includes(deep.stage) ? (
                <Button label="진행 확인" busy={deepBusy} onPress={() => void pokeDeep()} />
              ) : (
                <Button
                  label={deep.stage === "error" ? "다시 시작" : "다시 분석"}
                  busy={deepBusy}
                  onPress={() => void runDeep()}
                />
              )}
            </>
          ) : (
            <Button
              label="심층 분석 시작"
              tone="primary"
              busy={deepBusy}
              onPress={() => void runDeep()}
            />
          )}
        </Card>
      ) : null}

      {/* 탭 — 보고서와 근무 환경 */}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {(
          [
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

          {/* 확인 목록 — 웹 추정은 카드가 아니라 여기 남는다. 해소는 채팅의 임상 판단 모드에서. */}
          {confirmations.length > 0 ? (
            <Card tone="warn">
              <Heading>확인 목록</Heading>
              <Small>
                안 들렸거나 웹 추정만 있는 항목입니다. 카드로 만들지 않았습니다 — 선배에게
                확인한 뒤, 채팅의 &lsquo;임상 판단&rsquo; 모드에서 해소하십시오.
              </Small>
              {confirmations.map((c) => (
                <View key={c.id} style={{ gap: 2, paddingVertical: space.sm }}>
                  <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                    <Badge text={c.resolved ? "해소됨" : "미확인"} tone={c.resolved ? "ok" : "warn"} />
                    {c.source_id ? <Small>{c.source_id}</Small> : null}
                  </View>
                  <Body>{c.question}</Body>
                  {c.candidate ? <Small>후보: {c.candidate} (확정 아님)</Small> : null}
                  {c.resolved && c.result ? <Small muted={false}>확인 결과: {c.result}</Small> : null}
                  <Divider />
                </View>
              ))}
            </Card>
          ) : null}

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

  전사 결과 화면에서 화자를 지정한 후 ‘카드·보고서 만들기’를 누르십시오.
</Body>
          </Card>
        )
      ) : null}
    </ScrollView>
  );
}
