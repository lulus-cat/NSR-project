/**
 * 근무 기록 — 전사를 돌리고, 보고서와 근무 환경을 보는 화면.
 *
 * 전사 **결과**(문장 목록·재생·수정)는 여기 없다. `/transcript/[id]` 로
 * 분리했다 — 결과와 실행이 한 화면에 있으면 전사가 끝나는 순간 수천
 * 문장이 이 화면에 쏟아져 모든 것이 무거워진다. 여기는 가볍게 남는다.
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  DEFAULT_TEMPLATES,
  type TaeumScore,
  type ShiftCode,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../../src/components/ui";
import { radius, space, type, useTheme } from "../../src/theme";
import {
  countSegments,
  getShiftReportMarkdown,
  getTaeumScore,
  listRecordings,
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

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type Tab = "report" | "environment";

export default function ShiftDetail() {
  const t = useTheme();
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

  const load = useCallback(async () => {
    const [count, recs, score, md] = await Promise.all([
      countSegments(shiftId),
      listRecordings(shiftId),
      getTaeumScore(shiftId),
      getShiftReportMarkdown(shiftId),
    ]);
    setSentenceCount(count);
    setRecordings(recs);
    setTaeum(score);
    setReportMd(md);
  }, [shiftId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
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
