import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Body, Button, Card, Heading, Small } from "../src/components/ui";
import { useApp } from "../src/state/AppContext";
import { TOUCH_MIN, radius, space, type, useTheme } from "../src/theme";
import { setSetting } from "../src/db";
import { searchWorkplace, setWorkplacePlace, type PlaceHit } from "../src/services/geofence";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Location from "expo-location";

/**
 * 초기 설정 — 근무지 → 파트 → 전사 모델 → 필수 확인.
 *
 * 마지막 단계(법적 고지)만은 건너뛸 수 없다. 나머지는 전부 "나중에"가 된다 —
 * 첫 실행에서 막히는 앱은 두 번 열리지 않는다.
 */

const PARTS = [
  { key: "ward", label: "일반 병동" },
  { key: "icu", label: "중환자실" },
  { key: "er", label: "응급실" },
  { key: "or", label: "수술실" },
  { key: "ltc", label: "요양병원" },
  { key: "etc", label: "기타" },
];

const MODEL_CHOICES = [
  {
    key: "small-q5_1",
    title: "Small (추천 시작점)",
    body: "즉시 사용 가능합니다. 한국어 인식률이 낮아 향후 타 모델 변경을 권장합니다.",
  },
  {
    key: "korean-medium",
    title: "한국어 Medium (대화체)",
    body: "실전 대화 데이터로 학습된 모델입니다. 정확도가 훨씬 높지만 파일 준비 단계가 필요합니다 — 설정 > 전사 모델의 안내를 따르십시오.",
  },
  {
    key: "later",
    title: "나중에 정하기",
    body: "건너뛴 후 첫 전사 전 설정 > 전사 모델에서 다운로드할 수 있습니다.",
  },
];

const ITEMS: { key: string; title: string; body: string }[] = [
  {
    key: "wiretap",
    title: "당사자가 아닌 타인 간 대화 기록 금지",
    body:
      "통신비밀보호법상 본인이 참여하지 않은 타인 간 대화 기록은 불법이며 1년 이상 징역형 대상입니다. 항상 기기를 휴대해야 하며, 앱은 무음 및 타인 전용 구간을 자동 폐기합니다.",
  },
  {
    key: "medical",
    title: "기록 내 민감 정보 포함 주의",
    body:
      "의료법 제19조는 업무상 알게 된 비밀의 누설을 금지합니다. 모든 데이터는 기기 내에서 처리되며 외부 송신은 기본 차단됩니다. 공유 및 내보내기 시 신중을 기하십시오.",
  },
  {
    key: "hospital",
    title: "원내 규정에 따른 기록 금지 확인",
    body:
      "취업규칙상 원내 무단 기록은 징계 사유가 될 수 있습니다. 병원별 내규를 반드시 사전에 확인하십시오.",
  },
  {
    key: "indicator",
    title: "OS 마이크 상태 표시 안내",
    body:
      "iOS 주황색 표시와 Android 마이크 아이콘은 OS 필수 시스템 표시입니다. 앱 자체 소리·진동은 없으나 OS 상태 아이콘은 숨길 수 없습니다.",
  },
  {
    key: "score",
    title: "태움 지표는 판정이 아니라 기록입니다",
    body:
      "텍스트만으로는 어조나 맥락이 담기지 않습니다. 점수는 참고용 지표이며 실제 발언 인용문 확인이 필요합니다. 문제 발생 시 전문가와 상담하십시오.",
  },
  {
    key: "device",
    title: "기기 분실 시 데이터 유출 주의",
    body:
      "개인정보 보호를 위해 앱 잠금 사용을 권장합니다. 보관 기간이 만료된 기록 파일은 자동 삭제됩니다.",
  },
  {
    key: "alpha",
    title: "알파 버전 안내",
    body:
      "알파 버전은 기능 및 저장 형식이 변경될 수 있습니다. 중요 기록 파일은 별도로 백업하십시오. " +
      "화자는 자동 분리되지 않아 전사 화면에서 직접 지정해야 하며, 전사에는 모델 다운로드가 먼저 필요합니다.",
  },
];

const STEPS = ["근무지", "파트", "전사 모델", "필수 확인"];

export default function Onboarding() {
  const t = useTheme();
  const app = useApp();
  const [step, setStep] = useState(0);

  // 1단계 — 근무지
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [picked, setPicked] = useState<PlaceHit | null>(null);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  // 2단계 — 파트
  const [part, setPart] = useState<string | null>(null);
  // 3단계 — 모델
  const [model, setModel] = useState<string | null>(null);
  // 4단계 — 고지
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [micGranted, setMicGranted] = useState(false);
  const [locGranted, setLocGranted] = useState(false);
  const [starting, setStarting] = useState(false);
  const allChecked = ITEMS.every((i) => checked[i.key]);

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.bottom }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 진행 표시 — 숫자 원과 잇는 선 */}
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.sm }}>
          {STEPS.map((label, i) => (
            <View key={label} style={{ flexDirection: "row", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : 0 }}>
              <View style={{ alignItems: "center", gap: 4 }}>
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: i <= step ? t.accent : t.surfaceAlt,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {i < step ? (
                    <Ionicons name="checkmark" size={15} color="#FFFFFF" />
                  ) : (
                    <Text style={{ color: i <= step ? "#FFFFFF" : t.textMuted, fontWeight: "700", fontSize: 13 }}>
                      {i + 1}
                    </Text>
                  )}
                </View>
                <Text style={[type.caption, { color: i === step ? t.text : t.textMuted }]}>{label}</Text>
              </View>
              {i < STEPS.length - 1 ? (
                <View style={{ flex: 1, height: 2, marginBottom: 18, backgroundColor: i < step ? t.accent : t.border }} />
              ) : null}
            </View>
          ))}
        </View>

        {/* ── 1. 근무지 ── */}
        {step === 0 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>
  근무하는 병원을 선택하십시오.
</Text>
            <Small>
              근무지를 지정하면 병원에 들어설 때 기록이 자동으로 켜지고 나설 때 꺼집니다.
              검색어만 지도 서버(OpenStreetMap)로 가고, 내 위치는 보내지 않습니다.
            </Small>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="병원 이름 (예: 서울아산병원)"
                placeholderTextColor={t.textMuted}
                style={{
                  flex: 1,
                  color: t.text,
                  backgroundColor: t.surfaceAlt,
                  borderRadius: radius.md,
                  paddingHorizontal: space.md,
                  minHeight: TOUCH_MIN,
                  fontSize: 15,
                }}
              />
              <Button
                label="검색"
                tone="primary"
                onPress={async () => {
                  try {
                    const r = await searchWorkplace(query);
                    setHits(r.hits);
                    setSearchMsg(r.hits.length === 0 ? "찾지 못했습니다. 정식 명칭으로 다시 시도해 보십시오. 설정 > 공공데이터 키를 등록하면 전국 병원에서 검색됩니다." : null);
                  } catch (e) {
                    setSearchMsg(e instanceof Error ? e.message : "검색에 실패했습니다.");
                  }
                }}
              />
            </View>
            {hits.map((h) => {
              const on = picked?.name === h.name;
              return (
                <Pressable key={`${h.latitude},${h.longitude}`} accessibilityRole="button" onPress={() => setPicked(h)}>
                  <Card tone={on ? "accent" : "default"}>
                    <Body>{h.name}</Body>
                  </Card>
                </Pressable>
              );
            })}
            {searchMsg ? <Small muted={false}>{searchMsg}</Small> : null}
            <Button
              label={picked ? "이 병원으로 선택" : "나중에 지정하기"}
              tone="primary"
              onPress={async () => {
                if (picked) await setWorkplacePlace(picked);
                next();
              }}
            />
          </>
        ) : null}

        {/* ── 2. 파트 ── */}
        {step === 1 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>
  근무 파트를 선택하십시오.
</Text>
            <Small>
  파트에 따라 해당 사전의 우선순위가 적용됩니다.
</Small>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {PARTS.map((p) => {
                const on = part === p.key;
                return (
                  <Pressable
                    key={p.key}
                    accessibilityRole="button"
                    onPress={() => setPart(p.key)}
                    style={{
                      width: "48%",
                      minHeight: 56,
                      borderRadius: radius.lg,
                      backgroundColor: on ? t.accent : t.surface,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: on ? "#FFFFFF" : t.text, fontWeight: "700", fontSize: 15 }}>
                      {p.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Button
              label={part ? "다음" : "나중에 정하기"}
              tone="primary"
              onPress={async () => {
                if (part) await setSetting("profile.part", part);
                next();
              }}
            />
          </>
        ) : null}

        {/* ── 3. 모델 ── */}
        {step === 2 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>
  사용할 전사 모델을 선택하십시오.
</Text>
            <Small>
              
  모델 다운로드는 설정 &gt; 전사 모델에서 진행되며, 여기서는 사용할 유형만 선택합니다.
</Small>
            {MODEL_CHOICES.map((m) => {
              const on = model === m.key;
              return (
                <Pressable key={m.key} accessibilityRole="button" onPress={() => setModel(m.key)}>
                  <Card tone={on ? "accent" : "default"}>
                    <Heading>{m.title}</Heading>
                    <Small>{m.body}</Small>
                  </Card>
                </Pressable>
              );
            })}
            <Button
              label="다음"
              tone="primary"
              onPress={async () => {
                if (model) await setSetting("profile.plannedModel", model);
                next();
              }}
            />
          </>
        ) : null}

        {/* ── 4. 필수 확인 ── */}
        {step === 3 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>시작하기 전에</Text>
            <Small>
  모든 항목에 동의해야 서비스를 이용할 수 있습니다.
</Small>
            {ITEMS.map((item) => {
              const on = !!checked[item.key];
              return (
                <Pressable
                  key={item.key}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  onPress={() => setChecked((c) => ({ ...c, [item.key]: !c[item.key] }))}
                >
                  <Card tone={on ? "accent" : "default"}>
                    <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start" }}>
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: radius.sm,
                          borderWidth: 2,
                          borderColor: on ? t.accent : t.border,
                          backgroundColor: on ? t.accent : "transparent",
                          alignItems: "center",
                          justifyContent: "center",
                          marginTop: 2,
                        }}
                      >
                        {on ? <Text style={{ color: "#fff", fontWeight: "700" }}>✓</Text> : null}
                      </View>
                      <View style={{ flex: 1, gap: space.xs }}>
                        <Heading>{item.title}</Heading>
                        <Body muted>{item.body}</Body>
                      </View>
                    </View>
                  </Card>
                </Pressable>
              );
            })}
            {/* 권한 — 여기서 미리 받아 두면 첫 기록에서 안 막힌다 */}
            <Card>
              <Heading>권한 허용</Heading>
              <Small>
                마이크는 필수입니다. 위치는 근무지 자동 기록을 쓸 때만 필요하고,
                지금 건너뛰어도 설정에서 켤 수 있습니다.
              </Small>
              <Button
                label={micGranted ? "✓ 마이크 허용됨" : "마이크 허용 (필수)"}
                tone={micGranted ? "default" : "primary"}
                onPress={async () => {
                  const r = await requestRecordingPermissionsAsync();
                  setMicGranted(r.granted);
                }}
              />
              <Button
                label={locGranted ? "✓ 위치 허용됨" : "위치 허용 (선택 — 근무지 자동 기록)"}
                onPress={async () => {
                  const r = await Location.requestForegroundPermissionsAsync();
                  setLocGranted(r.granted);
                }}
              />
            </Card>

            <Button
              label={starting ? "준비하는 중" : allChecked ? "확인했습니다 — 시작" : "위 항목을 모두 확인하십시오."}
              tone="primary"
              disabled={!allChecked || starting}
              busy={starting}
              onPress={() => {
                setStarting(true);
                void app.completeOnboarding();
              }}
            />
            <Small>기록 기능은 기본으로 비활성화되어 있습니다. 설정에서 직접 활성화하십시오.</Small>
          </>
        ) : null}

        {step > 0 && step < 3 ? (
          <Button label="이전" onPress={() => setStep((s) => s - 1)} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
