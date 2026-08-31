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
          `텍스트 변환 중 ${s.percent}% (${s.fileIndex}/${s.fileCount})${s.note ? ` · ${s.note}` : ""}`,
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
      setError("이미 다른 거 돌리고 있거나 변환할 녹음이 없어요!");
    }
  }, [shiftId, pending]);

  const runFinalize = useCallback(async () => {
    setError(null);
    setBusy("예쁘게 각 잡는 중");
    try {
      await finalizeShift({ shiftId, date: date ?? "", dutyLabel, recordedSec: durationSec });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "앗 각 잡기 실패 ㅠㅠ 다시 해봐요");
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
        setError(e instanceof Error ? e.message : "삐빅 재생 불가");
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
    setBusy("밖으로 빼는 중");
    try {
      const outcome = await shareText({
        text: preview.text,
        fileName: `${date ?? "듀티"}-${code ?? ""}-리포트`,
        title: `${dutyLabel} 리포트 밖으로 슝`,
      });
      if (!outcome.shared && outcome.message) setError(outcome.message);
      else setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "앗 공유 엎어짐");
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
              busy?.startsWith("텍스트 변환")
                ? busy
                : runnerBusy
                  ? "딴 듀티 변환하느라 바쁨"
                  : `밀린 녹음 ${pending.length}건 싹 다 바꾸기`
            }
            tone="primary"
            busy={busy?.startsWith("텍스트 변환") ?? false}
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
          <Heading>음성 파일 원본</Heading>
          <Small>
            요 듀티 때 털린 녹음 원본이에요. 변환하기 전에 재생 버튼 눌러서 먼저 살짝 들어볼 수 있어요
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
                    accessibilityLabel={playingThis ? "그만 듣기" : "맛보기 재생"}
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
                      {clock} 시작{mins > 0 ? ` · ${mins}분 (순삭)` : ""}
                    </Text>
                    <Text style={[type.small, TABULAR, { color: t.textMuted, fontWeight: "600" }]}>
                      {mb ? `${mb}MB` : "사이즈 모름"}
                      {r.file_uri ? "" : " · 파일 없음 휑~"}
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
          <Heading>변환 결과물</Heading>
          <Small>
            {sentenceCount}문장 · 문장별 재생, 화자 지정, 단어 수정, AI 다듬기는 결과
            화면에서 합니다.
          </Small>
          <Button
            label="결과물 까보기"
            tone="primary"
            onPress={() => router.push(`/transcript/${encodeURIComponent(shiftId)}`)}
          />
          <Button
            label={reportMd ? "다시 예쁘게 각 잡기" : "단어장·리포트 뚝딱 만들기"}
            busy={busy === "예쁘게 각 잡는 중"}
            onPress={() => void runFinalize()}
          />
        </Card>
      ) : null}

      {/* ── 심층 분석 — Claude 추출·조사 + Gemini 보고서. 배치라 몇 분~몇 십 분 ── */}
      {sentenceCount > 0 ? (
        <Card>
          <Heading>초정밀 심층 분석 (AI 3단 콤보)</Heading>
          <Small>
            똑순이 Claude 5가 피드백 포인트 딱 짚어내고, Claude Fable 5가 폭풍 구글링으로 팩트 체크 갈기고, Gemini가 리포트랑 단어장으로 예쁘게 빚어냅니다. 이 콤보 돌아가는 데 몇 분~몇 십 분 걸려요. 화면 꺼도 알아서 열일하니까 이따 와서 결과만 쏙 빼먹으세요
          </Small>
          {deepGate && !deepGate.ok ? (
            <Body muted>{deepGate.reason}</Body>
          ) : deep && deep.stage !== "idle" ? (
            <>
              <Badge
                text={
                  deep.stage === "done"
                    ? "갓벽하게 끝"
                    : deep.stage === "error"
                      ? "엎어짐"
                      : `열일 중 땀뻘뻘 · ${deep.stage} 단계`
                }
                tone={deep.stage === "done" ? "ok" : deep.stage === "error" ? "danger" : "warn"}
              />
              <Small muted={false}>{deep.detail}</Small>
              {deep.error ? <Text style={[type.small, { color: t.danger }]}>{deep.error}</Text> : null}
              {["3a", "3b", "4"].includes(deep.stage) ? (
                <Button label="어디쯤 왔나 찌르기" busy={deepBusy} onPress={() => void pokeDeep()} />
              ) : (
                <Button
                  label={deep.stage === "error" ? "재시동 부릉" : "처음부터 다시 갈기기"}
                  busy={deepBusy}
                  onPress={() => void runDeep()}
                />
              )}
            </>
          ) : (
            <Button
              label="심층 분석 풀악셀 시작!"
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
            ["environment", "오늘 우리 병동 분위기"],
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

  아직 뽑아둔 리포트가 없어요! 글자 변환 다 끝내고 ‘단어장·리포트 뚝딱 만들기’ 꾹 눌러주세요.
</Body>
            )}
          </Card>

          {/* 확인 목록 — 웹 추정은 카드가 아니라 여기 남는다. 해소는 채팅의 임상 판단 모드에서. */}
          {confirmations.length > 0 ? (
            <Card tone="warn">
              <Heading>쌤한테 물어볼 리스트</Heading>
              <Small>
                녹음이 웅얼거려서 안 들렸거나 AI가 뇌피셜로 때려 맞춘 것들이에요. 확실치 않아서 단어장엔 안 넣었어요 — 선배한테 리얼 팩트 체크하고, 채팅 탭 '임상 판단' 모드에서 털어버리세요!
              </Small>
              {confirmations.map((c) => (
                <View key={c.id} style={{ gap: 2, paddingVertical: space.sm }}>
                  <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                    <Badge text={c.resolved ? "궁금증 해결 완" : "아직 모름"} tone={c.resolved ? "ok" : "warn"} />
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
              <Heading>밖으로 슝</Heading>
              <Small>

  삐- 처리된 환자 이름이나 폰 번호 같은 거 다시 한 번 쳌쳌! 하고 보내세요 꼭
</Small>
              <Button label="요대로 나갑니다 쳌쳌!" onPress={() => void prepareExport()} />
            </Card>
          ) : null}

          {preview ? (
            <Card tone={preview.masked ? "default" : "warn"}>
              <Heading>
  이 내용 그대로 쏠게요
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

  저쪽 폰이랑 카톡 서버에 박제되는 거 알죠? 환자 정보 진짜진짜 없는지 마지막으로 눈 크게 뜨고 확인!
</Small>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="슝 보내버려"
                    tone="primary"
                    busy={busy === "밖으로 빼는 중"}
                    onPress={() => void doShare()}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label="앗차차 (취소)" onPress={() => setPreview(null)} />
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
                <Heading>입에서 나온 찐 발언</Heading>
                <Small>
  숫자 쪼가리보다 실제 내뱉은 한마디 한마디가 찐 증거죠
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
  오? 선 넘는 험악한 말은 안 잡혔어요
</Body>
                <Small>

  그렇다고 진짜 아무 일도 없었단 건 아님! 텍스트엔 꼽주는 뉘앙스가 안 담기니까요
</Small>
              </Card>
            )}

            {taeum.patientAggression.length > 0 ? (
              <Card>
                <Heading>멱살잡이 텐션 (폭언)</Heading>
                <Small>

  환자/보호자가 쌍욕 박는 건 산업안전보건법 위반이에요 병원 매뉴얼대로 참교육(대응) 가즈아!
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
              <Heading>꿀팁 참고</Heading>
              <Small>

  근로기준법 센세는 직장 내 괴롭힘이랑 보복성 꼽주기를 절대 용서치 않습니다
</Small>
              <Small>
                SOS 칠 곳: 소속 병원 고충처리 부서 · 대한간호협회 간호사 인권센터 · 고용노동부 노동포털
              </Small>
            </Card>
          </>
        ) : (
          <Card>
            <Body muted>

  텍스트 변환 창에서 누가 말한 건지 콕콕 찍어준 다음 ‘단어장·리포트 만들기’ 누르면 훨씬 깔쌈해져요
</Body>
          </Card>
        )
      ) : null}
    </ScrollView>
  );
}
