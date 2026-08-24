import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  DEFAULT_TEMPLATES,
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
  setSpeakerRoleForCluster,
  type RecordingRow,
} from "../../src/db";
import { finalizeShift, processRecording, resolveProvider } from "../../src/services/asr";

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

  /** 화자 클러스터 목록. 라벨은 한 번만 붙이면 클러스터 전체에 적용된다. */
  const clusters = useMemo(() => {
    const map = new Map<string, { count: number; role: SpeakerRole; sample: string }>();
    for (const seg of segments) {
      const id = seg.speakerId ?? "unknown";
      const prev = map.get(id);
      if (prev) {
        prev.count += 1;
      } else {
        map.set(id, {
          count: 1,
          role: seg.speakerRole ?? "unknown",
          sample: seg.text.slice(0, 40),
        });
      }
    }
    return [...map.entries()];
  }, [segments]);

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

  const unlabeled = clusters.some(([, c]) => c.role === "unknown");

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
      </Card>

      {/* 화자 라벨 — 태움 판단의 전제 */}
      {clusters.length > 0 ? (
        <Card tone={unlabeled ? "warn" : "default"}>
          <Heading>누가 말했나요</Heading>
          <Small>
            화자를 나눠두었지만 누구인지는 앱이 모릅니다. 한 번만 지정하면 그 화자의 모든 발화에
            적용됩니다. 근무 환경 기록은 이 라벨이 있어야 계산됩니다.
          </Small>
          {clusters.map(([speakerId, info]) => (
            <View key={speakerId} style={{ gap: space.sm, paddingVertical: space.sm }}>
              <Small muted={false}>
                {speakerId} · {info.count}회 · &ldquo;{info.sample}…&rdquo;
              </Small>
              <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
                {ROLE_OPTIONS.map((opt) => {
                  const on = info.role === opt.role;
                  return (
                    <Pressable
                      key={opt.role}
                      accessibilityRole="button"
                      onPress={async () => {
                        await setSpeakerRoleForCluster(shiftId, speakerId, opt.role);
                        await load();
                      }}
                      style={{
                        paddingVertical: space.xs,
                        paddingHorizontal: space.md,
                        borderRadius: radius.sm,
                        backgroundColor: on ? t.accent : t.surfaceAlt,
                      }}
                    >
                      <Text
                        style={{ color: on ? "#fff" : t.text, fontSize: 13, fontWeight: "600" }}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Divider />
            </View>
          ))}
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
          segments.map((seg) => (
            <Card key={seg.id}>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Badge
                  text={ROLE_LABELS[seg.speakerRole ?? "unknown"]}
                  tone={seg.speakerRole === "self" ? "ok" : "muted"}
                />
                <Small>{formatTime(seg.startSec)}</Small>
              </View>
              <Body>{seg.text}</Body>
              {seg.text !== seg.rawText ? (
                <Small>원문: {seg.rawText}</Small>
              ) : null}
            </Card>
          ))
        )
      ) : null}

      {tab === "report" ? (
        <Card>
          {reportMd ? (
            <Text style={[type.body, { color: t.text }]}>{reportMd}</Text>
          ) : (
            <Body muted>
              아직 보고서가 없습니다. 전사를 마친 뒤 &lsquo;카드·보고서 만들기&rsquo;를 눌러주세요.
            </Body>
          )}
        </Card>
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
