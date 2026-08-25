import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, RefreshControl, View } from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { DISCLAIMER, taeumTemperature } from "@nsr/core";
import { Badge, Body, Card, Divider, Heading, HeaderScreen, Row, Small } from "../../src/components/ui";
import { TABULAR, radius, space, type, useTheme } from "../../src/theme";
import { listTaeumScores } from "../../src/db";

/**
 * 마음 — 근무 환경을 체온으로 본다.
 *
 * 숫자 점수는 감각이 없다. 체온은 간호사의 직업 감각 그 자체다.
 * 36.5 는 설명이 필요 없고 38.6 은 보는 순간 "조치" 로 읽힌다.
 * 그래서 태움 지수를 여기서는 처음부터 끝까지 체온으로만 말한다.
 */

interface TempRecord {
  shiftId: string;
  date: string;
  temp: ReturnType<typeof taeumTemperature>;
}

export default function Care() {
  const t = useTheme();
  const router = useRouter();
  const [records, setRecords] = useState<TempRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const scores = await listTaeumScores(30);
    setRecords(
      scores.map((s) => ({
        shiftId: s.shiftId,
        date: s.shiftId.split(":")[0],
        temp: taeumTemperature(s.score),
      })),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const latest = records[0];
  const feverish = records.filter((r) => r.temp.tone === "danger" || r.temp.tone === "warn");
  const avg =
    records.length > 0
      ? Math.round((records.reduce((a, r) => a + r.temp.celsius, 0) / records.length) * 10) / 10
      : null;

  const toneColor = { ok: t.ok, muted: t.textMuted, warn: t.warn, danger: t.danger } as const;

  return (
    <HeaderScreen
      title="마음"
      heroLabel="최근 근무 체온"
      hero={latest ? `${latest.temp.celsius}°C` : "—"}
      rows={[
        { label: "최근 30근무 평균", value: avg !== null ? `${avg}°C` : "기록 없음" },
        {
          label: "열이 있었던 근무",
          value: `${feverish.length}번`,
          tone: feverish.length > 0 ? "alert" : "default",
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {latest ? (
        <Card tone={latest.temp.tone === "danger" ? "warn" : "default"}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Badge text={latest.temp.label} tone={latest.temp.tone} />
            <Heading>{latest.date.replace(/-/g, ".")} 근무</Heading>
          </View>
          <Body>{latest.temp.description}</Body>
          <Small>
  점수보다 인용문이 중요합니다. 근무 기록에서 실제 발언을 확인하십시오.
</Small>
        </Card>
      ) : (
        <Card>
          <Heading>아직 기록이 없습니다</Heading>
          <Body muted>
            
  근무를 녹음하고 전사하면 근무 환경이 체온으로 기록됩니다. 36.5°C면 안정적인 병동입니다.
</Body>
        </Card>
      )}

      {/* 체온 기록 */}
      {records.length > 0 ? (
        <Card>
          <Heading>체온 기록</Heading>
          {records.map((r) => (
            <View key={r.shiftId}>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/shift/${encodeURIComponent(r.shiftId)}`)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingVertical: space.sm,
                  minHeight: 44,
                }}
              >
                <Text style={[type.body, { color: t.text }]}>{r.date.replace(/-/g, ".")}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  {/* 체온 막대 — 35.5~40.0 을 폭으로 */}
                  <View
                    style={{
                      width: 72,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: t.surfaceAlt,
                      overflow: "hidden",
                    }}
                  >
                    <View
                      style={{
                        width: Math.max(
                          6,
                          Math.min(72, ((r.temp.celsius - 35.5) / 4.5) * 72),
                        ),
                        height: 6,
                        backgroundColor: toneColor[r.temp.tone],
                      }}
                    />
                  </View>
                  <Text style={[type.body, TABULAR, { color: toneColor[r.temp.tone], fontWeight: "700" }]}>
                    {r.temp.celsius.toFixed(1)}°
                  </Text>
                </View>
              </Pressable>
              <Divider />
            </View>
          ))}
          <Small>36.5° 정상 · 37.0° 미열 · 37.6° 발열 · 38.6° 고열</Small>
        </Card>
      ) : null}

      {/* 스스로 살피기 */}
      <Card>
        <Heading>열이 계속되면</Heading>
        <Body>
          
  체온이 며칠씩 37.6°C를 넘는다면 개인 버티기의 문제가 아닌 환경 문제입니다. 기록 자체가 대비입니다 — 날짜·상황·실제 인용문이 앱에 남습니다.
</Body>
        <Divider />
        <Row
          label="직장 내 괴롭힘 상담"
          value="1522-9000"
          onPress={() => void Linking.openURL("tel:15229000")}
        />
        <Small>
  고용노동부 직장 내 괴롭힘 상담센터입니다. 익명 상담이 가능합니다.
</Small>
        <Divider />
        <Row
          label="정신건강 위기상담"
          value="1577-0199"
          onPress={() => void Linking.openURL("tel:15770199")}
        />
        <Divider />
        <Row
          label="마음이 많이 힘든 날"
          value="109"
          onPress={() => void Linking.openURL("tel:109")}
        />
        <Small>
  24시간 전국 어디서나 전화 한 통이면 연결됩니다.
</Small>
      </Card>

      <Card>
        <Small>{DISCLAIMER}</Small>
      </Card>
    </HeaderScreen>
  );
}
