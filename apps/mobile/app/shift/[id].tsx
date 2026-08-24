import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
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
import { radius, space, type, useTheme } from "../../src/theme";
import {
  getShiftReportMarkdown,
  getTaeumScore,
  listRecordings,
  listSegments,
  loadCorrectionMemory,
  saveCorrectionMemory,
  saveUserTerm,
  setSpeakerRole,
  updateSegmentText,
  type RecordingRow,
} from "../../src/db";
import { finalizeShift, processRecording, resolveProvider } from "../../src/services/asr";
import { redactForExport, shareText, type RedactedText } from "../../src/services/export";

const ROLE_OPTIONS: { role: SpeakerRole; label: string }[] = [
  { role: "self", label: "본인" },
  { role: "senior", label: "선배" },
  { role: "doctor", label: "의사" },
  { role: "patient", label: "환자" },
  { role: "guardian", label: "보호자" },
  { role: "other", label: "기타" },
];

const ROLE_LABELS: Record<SpeakerRole, string> = {
  self: "본인",
  senior: "선배",
  doctor: "의사",
  patient: "환자",
  guardian: "보호자",
  other: "기타",
  unknown: "미확인",
};

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type Tab = "transcript" | "report" | "environment";

/**
 * 문장 한 줄.
 *
 * 두 가지를 동시에 받아야 한다 — **문장 누르기**(화자 구간)와
 * **단어 길게 누르기**(고치기). 그래서 어절마다 Pressable 을 두고,
 * 짧게 누르면 문장 쪽으로 넘기고 길게 누르면 단어 쪽으로 넘긴다.
 *
 * 어절 단위로 자르는 이유: 한국어는 조사가 붙어 있어 "폴리를" 이 한 덩어리다.
 * 글자 단위로 고르게 하면 폰에서 정확히 짚기가 어렵다.
 */
function SentenceCard({
  segment,
  isRangeStart,
  onPressSentence,
  onPressWord,
}: {
  segment: TranscriptSegment;
  isRangeStart: boolean;
  onPressSentence: () => void;
  onPressWord: (word: string) => void;
}) {
  const t = useTheme();
  const role = segment.speakerRole ?? "unknown";
  const words = segment.text.split(/(\s+)/).filter((w) => w.length > 0);

  return (
    <Card tone={isRangeStart ? "accent" : "default"}>
      <Pressable accessibilityRole="button" onPress={onPressSentence}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Badge
            text={ROLE_LABELS[role]}
            tone={role === "self" ? "ok" : role === "unknown" ? "warn" : "muted"}
          />
          <Small>{formatTime(segment.startSec)}</Small>
        </View>
      </Pressable>

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
              accessibilityLabel={`${word} — 길게 누르면 고칩니다`}
              onPress={onPressSentence}
              onLongPress={() => onPressWord(word)}
              delayLongPress={300}
            >
              <Text style={[type.body, { color: t.text }]}>{word}</Text>
            </Pressable>
          ),
        )}
      </View>

      {segment.text !== segment.rawText ? (
        <Small>원문: {segment.rawText}</Small>
      ) : null}
    </Card>
  );
}

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

  /**
   * 화자 지정 진행 상황.
   *
   * 온디바이스 whisper.cpp 는 화자를 나누지 못하므로 speakerId 가 없다.
   * 그래서 클러스터로 묶는 대신 **문장 구간**으로 지정한다.
   */
  const coverage = useMemo(() => speakerCoverage(segments), [segments]);

  /** 구간 지정 중일 때의 시작 문장 id. 두 번째를 누르면 그 사이가 지정된다. */
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<SpeakerRole>("senior");
  /** 단어를 눌렀을 때 뜨는 패널. */
  const [wordTarget, setWordTarget] = useState<
    { segmentId: string; word: string; replacement: string } | null
  >(null);

  const pending = recordings.filter((r) => r.state === "recorded");
  const durationSec = recordings.reduce((sum, r) => sum + r.duration_sec, 0);
  const dutyLabel = DEFAULT_TEMPLATES[(code as ShiftCode) ?? "OTHER"]?.label ?? "근무";

  const runTranscription = useCallback(async () => {
    setError(null);
    setBusy("전사 중");
    try {
      const provider = await resolveProvider();
      for (const rec of pending) {
        setBusy(`전사 중 (${rec.seq + 1}/${pending.length})`);
        await processRecording(rec, provider);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "전사에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }, [load, pending]);

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

  /**
   * 내보내기는 두 걸음이다.
   *   1) 가린 결과를 **먼저 보여준다**
   *   2) 사용자가 눈으로 확인한 뒤에 공유 시트가 열린다
   *
   * 한 번에 공유 시트를 여는 편이 편하지만, 그러면 무엇이 나가는지 모르는 채로
   * 나간다. 되돌릴 수 없는 일에는 한 걸음을 더 두는 게 맞다.
   */
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
        title: `${dutyLabel} 보고서 보내기`,
      });
      if (!outcome.shared && outcome.message) setError(outcome.message);
      else setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "공유하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }, [code, date, dutyLabel, preview]);


  /**
   * 구간 지정. 첫 번째 누름은 시작점, 두 번째 누름은 끝점이다.
   *
   * 같은 문장을 두 번 누르면 그 한 줄만 지정된다 — 한 줄만 다른 사람인 경우가
   * 실제로 있어서(짧은 대답) 취소가 아니라 단일 지정으로 둔다.
   */
  const toggleRange = useCallback(
    async (segmentId: string) => {
      if (!rangeStart) {
        setRangeStart(segmentId);
        return;
      }
      const next = assignSpeakerRange(segments, rangeStart, segmentId, pendingRole);
      setRangeStart(null);
      setSegments(next);
      // 바뀐 것만 저장한다. 수백 줄을 매번 다 쓰면 느려진다.
      const changed = next.filter(
        (n, i) => n.speakerRole !== segments[i]?.speakerRole,
      );
      for (const seg of changed) {
        if (seg.speakerRole) await setSpeakerRole(seg.id, seg.speakerRole);
      }
    },
    [pendingRole, rangeStart, segments],
  );

  /**
   * 단어 하나를 고친다.
   *
   * 본문만 바꾸고 **rawText 는 절대 안 건드린다.** 원문이 남아 있어야
   * 나중에 "앱이 고친 것인지 내가 고친 것인지" 를 가릴 수 있다.
   */
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

    // 교정 이력에 쌓는다. 같은 교정이 minCount(기본 2)번 넘으면 다음 전사부터
    // 자동으로 적용된다 — 같은 병동에서 같은 말이 반복해서 틀리기 때문이다.
    const memory = await loadCorrectionMemory();
    await saveCorrectionMemory(recordCorrection(memory, word, to, Date.now()));
  }, [segments, wordTarget]);

  /**
   * 이 말을 내 사전에 담는다.
   *
   * 뜻은 비워 둔다. 지금 채우라고 하면 흐름이 끊겨서 아무도 안 담는다.
   * 담아만 두면 다음 전사부터 이 말을 알아듣고, 뜻은 나중에 채우면 된다.
   */
  const addToMyDict = useCallback(async () => {
    if (!wordTarget) return;
    const surface = wordTarget.word.trim();
    if (surface.length < 2) {
      setError("두 글자 이상만 담을 수 있습니다.");
      return;
    }
    await saveUserTerm({
      id: `user-${Date.now().toString(36)}`,
      ko: surface,
      aliases: [],
      category: "workflow",
      definition: "우리 병동에서 쓰는 말. 뜻을 채워 주세요.",
    });
    setWordTarget(null);
    setError(null);
    setBusy(null);
    setNotice(`'${surface}'${josa(surface, "을")} 내 사전에 담았습니다. 뜻은 병동 사전 화면에서 채우세요.`);
  }, [wordTarget]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Card>
        <Heading>
          {date} · {dutyLabel}
        </Heading>
        <Small>
          녹음 {recordings.length}개 · 총 {Math.round(durationSec / 60)}분 · 전사 세그먼트{" "}
          {segments.length}개
        </Small>
        {pending.length > 0 ? (
          <Button
            label={`전사하지 않은 녹음 ${pending.length}개 전사하기`}
            tone="primary"
            busy={busy?.startsWith("전사") ?? false}
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
          <Heading>누가 말했나요</Heading>
          <Badge
            text={`${coverage.total}개 중 ${coverage.labeled}개 지정`}
            tone={coverage.readyForScoring ? "ok" : "warn"}
          />
          <Small muted={false}>{coverage.message}</Small>
          <Divider />
          <Small>
            기기 안에서 도는 Whisper 는{" "}
            <Text style={{ fontWeight: "700" }}>목소리를 구별하지 못합니다.</Text> 음성을
            글자로 옮기는 모델이지 누가 말했는지 가리는 모델이 아닙니다. 그건 별개의 모델이
            하는 일이고 폰에 올릴 수 있는 물건이 아닙니다. 그래서 직접 지정하셔야 합니다.
          </Small>
          <Small>
            한 줄씩 누르지 마세요. 아래에서 역할을 고른 뒤 전사 탭에서 <Text
            style={{ fontWeight: "700" }}>시작 문장과 끝 문장</Text>을 누르면 그 사이가
            한 번에 지정됩니다. 인계는 덩어리로 흐르니 대여섯 번이면 끝납니다.
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
          {rangeStart ? (
            <>
              <Small muted={false}>
                시작 지점을 잡았습니다. 끝 문장을 누르면 그 사이가 &lsquo;
                {ROLE_LABELS[pendingRole]}&rsquo;로 지정됩니다.
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
              아직 전사된 내용이 없습니다. 녹음이 있다면 위에서 전사를 실행하세요.
            </Body>
          </Card>
        ) : (
          <>
            <Card>
              <Small>
                문장을 누르면 화자 구간을 지정하고, <Text style={{ fontWeight: "700" }}>
                단어를 길게 누르면</Text> 고치거나 병동 사전에 담을 수 있습니다.
                고친 것은 다음 전사부터 자동으로 반영됩니다.
              </Small>
            </Card>
            {segments.map((seg) => (
              <SentenceCard
                key={seg.id}
                segment={seg}
                isRangeStart={rangeStart === seg.id}
                onPressSentence={() => void toggleRange(seg.id)}
                onPressWord={(word) =>
                  setWordTarget({ segmentId: seg.id, word, replacement: word })
                }
              />
            ))}
          </>
        )
      ) : null}

      {/* 단어 고치기 */}
      {wordTarget ? (
        <Card tone="accent">
          <Heading>&ldquo;{wordTarget.word}&rdquo;</Heading>
          <Small>
            음성인식이 잘못 받아적었다면 고쳐 주세요. 두 번 넘게 같은 교정을 하면
            다음 전사부터 앱이 알아서 바꿉니다.
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
              <Button label="닫기" onPress={() => setWordTarget(null)} />
            </View>
          </View>
          <Divider />
          <Small muted={false}>우리 병동에서만 쓰는 말인가요?</Small>
          <Small>
            내 사전에 담아 두면 다음부터 이 말을 알아듣고, 학습카드에도 나옵니다.
            뜻은 나중에 병동 사전 화면에서 채우면 됩니다.
          </Small>
          <Button label="내 사전에 담기" onPress={() => void addToMyDict()} />
        </Card>
      ) : null}

      {tab === "report" ? (
        <>
          <Card>
            {reportMd ? (
              <Text style={[type.body, { color: t.text }]}>{reportMd}</Text>
            ) : (
              <Body muted>
                아직 보고서가 없습니다. 전사를 마친 뒤 &lsquo;카드·보고서 만들기&rsquo;를 눌러주세요.
              </Body>
            )}
          </Card>

          {reportMd && !preview ? (
            <Card>
              <Heading>내보내기</Heading>
              <Small>
                환자 이름·전화번호·등록번호를 가린 뒤 무엇을 가렸는지 보여 드립니다.
                확인하고 나서 보내세요.
              </Small>
              <Button label="내보낼 내용 확인" onPress={() => void prepareExport()} />
            </Card>
          ) : null}

          {preview ? (
            <Card tone={preview.masked ? "default" : "warn"}>
              <Heading>이대로 나갑니다</Heading>
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
                받는 사람의 폰에도 남습니다. 카카오톡으로 보내면 그 서버를 거칩니다.
                꼭 보내야 하는 것인지 한 번만 더 생각해 주세요.
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
                <Small>점수가 아니라 여기가 본체입니다.</Small>
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
                <Body muted>어휘 기준으로 잡힌 발언이 없습니다.</Body>
                <Small>
                  잡히지 않았다고 아무 일도 없었다는 뜻은 아닙니다. 어조와 맥락은 텍스트에 남지 않습니다.
                </Small>
              </Card>
            )}

            {taeum.patientAggression.length > 0 ? (
              <Card>
                <Heading>환자·보호자 폭언</Heading>
                <Small>
                  이건 동료 간 문제와 성격이 다릅니다. 산업안전보건법상 고객응대근로자 보호와
                  병원 보안 절차의 영역이며, 대응 경로도 다릅니다.
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
                근로기준법 제76조의2는 지위·관계의 우위를 이용해 업무상 적정범위를 넘어
                고통을 주거나 근무환경을 악화시키는 행위를 금지합니다. 제76조의3 제6항은
                신고자에 대한 불리한 처우를 별도로 금지합니다.
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
              아직 계산되지 않았습니다. 화자 라벨을 지정하고 &lsquo;카드·보고서 만들기&rsquo;를 눌러주세요.
            </Body>
          </Card>
        )
      ) : null}
    </ScrollView>
  );
}
