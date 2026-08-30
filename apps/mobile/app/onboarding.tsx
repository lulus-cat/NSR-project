import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Body, Button, Card, Heading, Small } from "../src/components/ui";
import { useApp } from "../src/state/AppContext";
import { TOUCH_MIN, radius, space, type, useTheme } from "../src/theme";
import { setSetting } from "../src/db";
import { SETTINGS_KEYS } from "../src/services/scheduler";
import { getApiKey, setApiKey } from "../src/services/llm";
import { AI_PATHS, setAiPath, type AiPath } from "../src/services/pipeline";
import { searchWorkplace, setWorkplacePlace, type PlaceHit } from "../src/services/geofence";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Location from "expo-location";

/**
 * 초기 설정 — 근무지 → 파트 → 전사 방식 → AI 설정 → 필수 확인.
 *
 * AI 설정과 마지막 법적 고지는 건너뛸 수 없다(사용자 결정 — 분석·보고서·
 * 대화가 전부 AI 필수라서). 나머지는 "나중에"가 된다.
 */

const PARTS = [
  { key: "ward", label: "일반 병동" },
  { key: "icu", label: "중환자실" },
  { key: "er", label: "응급실" },
  { key: "or", label: "수술실" },
  { key: "ltc", label: "요양병원" },
  { key: "etc", label: "기타" },
];

/**
 * 전사 방식 — 설정 → 전사 화면과 같은 갈래다. 온보딩과 설정이 다른 말을
 * 하면 사용자는 둘 다 못 믿는다. 여기서 고른 모드가 그 화면의 기본값이 된다.
 */
const METHOD_CHOICES = [
  {
    key: "colab",
    title: "구글 콜랩 (무료 GPU, 추천)",
    body: "컴퓨터 없이 무료 GPU가 전사합니다. 준비 3분 — 자세한 연결은 설정 → 전사에서 안내합니다.",
  },
  {
    key: "pc",
    title: "내 컴퓨터 (PC·노트북)",
    body: "같은 Wi-Fi의 내 컴퓨터가 전사합니다. 기록 음성이 집 밖으로 나가지 않습니다.",
  },
  {
    key: "gemini",
    title: "Gemini (구글 AI, 서버 없이)",
    body: "API 키 하나면 콜랩도 컴퓨터도 필요 없습니다. 키 발급은 설정 → 전사에서 안내합니다.",
  },
  {
    key: "later",
    title: "나중에 정하기",
    body: "지금 건너뛰어도 첫 전사 전에 설정 → 전사에서 연결하면 됩니다.",
  },
] as const;

const ITEMS: { key: string; title: string; body: string }[] = [
  {
    key: "wiretap",
    title: "당사자가 아닌 타인 간 대화 기록 금지",
    body:
      "타인 간 대화 녹음은 불법(징역형)입니다. 앱은 목소리로 사람을 구분하지 못하므로, 자리를 비울 때는 기록을 끄고 기기를 꼭 휴대하십시오.",
  },
  {
    key: "medical",
    title: "기록 내 민감 정보 포함 주의",
    body:
      "비밀 누설은 의료법 위반입니다. 모든 데이터는 기기 내 처리되며 외부 송신은 차단됩니다.",
  },
  {
    key: "hospital",
    title: "원내 규정에 따른 기록 금지 확인",
    body:
      "무단 녹음은 취업규칙 징계 사유가 될 수 있습니다. 병원 내규를 사전에 꼭 확인하십시오.",
  },
  {
    key: "indicator",
    title: "OS 마이크 상태 표시 안내",
    body:
      "마이크 아이콘 표시는 OS 필수 정책이라 숨길 수 없습니다. (앱 자체 소리나 진동은 없음)",
  },
  {
    key: "score",
    title: "태움 지표는 판정이 아니라 기록입니다",
    body:
      "점수는 참고용입니다. 어조가 담기지 않으니, 실제 인용문을 꼭 직접 확인하십시오.",
  },
  {
    key: "device",
    title: "기기 분실 시 데이터 유출 주의",
    body:
      "개인정보 보호를 위해 앱 잠금을 권장합니다. 보관 기한이 지난 파일은 지워집니다.",
  },
  {
    key: "alpha",
    title: "알파 버전 안내",
    body:
      "알파 버전이라 기능이 바뀔 수 있습니다. 중요한 기록은 따로 백업하십시오. " +
      "전사 전에 콜랩 또는 내 컴퓨터 서버를 연결해야 합니다. 화자 분리는 콜랩의 " +
      "화자 분리 옵션을 켜거나 전사 후 직접 지정합니다.",
  },
];

const STEPS = ["근무지", "파트", "전사 방식", "AI 설정", "필수 확인"];

export default function Onboarding() {
  const t = useTheme();
  const app = useApp();
  const [step, setStep] = useState(0);
  // AI 필수 설정 — 조합과 키 두 개가 저장돼야 다음으로 갈 수 있다.
  const [aiPath, setAiPathChoice] = useState<AiPath | null>(null);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [hasPathKey, setHasPathKey] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [pathKeyInput, setPathKeyInput] = useState("");

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
                    setSearchMsg(
                      r.hits.length === 0
                        ? r.source === "kakao"
                          ? "찾지 못했습니다. 지점명을 빼거나 철자를 바꿔 보십시오."
                          : "찾지 못했습니다. 정식 명칭(요양기관명)으로 다시 시도해 보십시오."
                        : null,
                    );
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

        {/* ── 3. 전사 방식 ── */}
        {step === 2 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>
  어디서 전사할지 선택하십시오.
</Text>
            <Small>
              전사는 폰이 아니라 콜랩(무료 GPU)·내 컴퓨터 또는 Gemini(구글 AI)가
              합니다. 기록 음성이 선택한 곳으로 전송됩니다. 여기서 고르면 설정 →
              전사에 기본으로 잡힙니다.
            </Small>
            {METHOD_CHOICES.map((m) => {
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
                if (model === "colab" || model === "pc" || model === "gemini") {
                  // 설정 → 전사 화면이 이 모드로 열린다. 주소는 거기서 잇는다.
                  await setSetting(SETTINGS_KEYS.cloudTranscription, {
                    enabled: false,
                    endpoint: "",
                    mode: model,
                  });
                }
                next();
              }}
            />
          </>
        ) : null}

        {/* ── 4. AI 필수 설정 — 두 조합 중 하나 + 키 두 개. 건너뛸 수 없다 ── */}
        {step === 3 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>AI 조합을 고르십시오</Text>
            <Small>
              분석·보고서·암기카드·대화가 전부 AI 로 돕니다. 이 설정 없이는 앱이
              동작하지 않아 건너뛸 수 없습니다. 전사본은 개인정보를 가린 뒤에만
              전송됩니다.
            </Small>
            {AI_PATHS.map((p) => {
              const on = aiPath === p.path;
              return (
                <Pressable
                  key={p.path}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={async () => {
                    setAiPathChoice(p.path);
                    await setAiPath(p.path);
                    setHasPathKey(
                      (await getApiKey(p.path === "claude" ? "anthropic" : "openai")) !== null,
                    );
                  }}
                >
                  <Card tone={on ? "accent" : "default"}>
                    <Heading>{p.title}</Heading>
                    <Small muted={false}>{p.models}</Small>
                    <Small>{p.why}</Small>
                  </Card>
                </Pressable>
              );
            })}
            {aiPath ? (
              <Card>
                <Small muted={false}>
                  1. Gemini 키{hasGeminiKey ? " — 저장됨 ✓" : " (aistudio.google.com/apikey 에서 발급)"}
                </Small>
                <TextInput
                  value={geminiKeyInput}
                  onChangeText={setGeminiKeyInput}
                  placeholder={hasGeminiKey ? "키가 저장되어 있습니다" : "AIza… 키 붙여넣기"}
                  placeholderTextColor={t.textMuted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    color: t.text,
                    backgroundColor: t.surfaceAlt,
                    borderRadius: radius.md,
                    padding: space.md,
                    fontSize: 14,
                  }}
                />
                <Button
                  label="Gemini 키 저장"
                  tone={hasGeminiKey ? "default" : "primary"}
                  onPress={async () => {
                    if (!geminiKeyInput.trim()) return;
                    await setApiKey(geminiKeyInput.trim(), "gemini");
                    setGeminiKeyInput("");
                    setHasGeminiKey(true);
                  }}
                />
                <Small muted={false}>
                  2. {aiPath === "claude" ? "Claude 키" : "OpenAI 키"}
                  {hasPathKey
                    ? " — 저장됨 ✓"
                    : aiPath === "claude"
                      ? " (console.anthropic.com 에서 발급)"
                      : " (platform.openai.com 에서 발급)"}
                </Small>
                <TextInput
                  value={pathKeyInput}
                  onChangeText={setPathKeyInput}
                  placeholder={hasPathKey ? "키가 저장되어 있습니다" : "API 키 입력"}
                  placeholderTextColor={t.textMuted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    color: t.text,
                    backgroundColor: t.surfaceAlt,
                    borderRadius: radius.md,
                    padding: space.md,
                    fontSize: 14,
                  }}
                />
                <Button
                  label={aiPath === "claude" ? "Claude 키 저장" : "OpenAI 키 저장"}
                  tone={hasPathKey ? "default" : "primary"}
                  onPress={async () => {
                    if (!pathKeyInput.trim()) return;
                    await setApiKey(
                      pathKeyInput.trim(),
                      aiPath === "claude" ? "anthropic" : "openai",
                    );
                    setPathKeyInput("");
                    setHasPathKey(true);
                  }}
                />
                <Small>키는 이 기기의 보안 저장소에만 보관되고, 설정에서 언제든 바꿀 수 있습니다.</Small>
              </Card>
            ) : null}
            <Button
              label={
                !aiPath
                  ? "조합을 먼저 고르십시오"
                  : !hasGeminiKey
                    ? "Gemini 키를 저장해야 넘어갑니다"
                    : !hasPathKey
                      ? (aiPath === "claude" ? "Claude" : "OpenAI") + " 키를 저장해야 넘어갑니다"
                      : "다음"
              }
              tone="primary"
              disabled={!aiPath || !hasGeminiKey || !hasPathKey}
              onPress={next}
            />
          </>
        ) : null}

        {/* ── 4. 필수 확인 ── */}
        {step === 4 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>시작하기 전에</Text>
            <Small>
  모든 항목을 확인하고 동의해 주십시오.
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
              label={starting ? "준비 중" : allChecked ? "확인했습니다 — 시작" : "위 항목을 모두 확인해 주십시오."}
              tone="primary"
              disabled={!allChecked || starting}
              busy={starting}
              onPress={() => {
                setStarting(true);
                void app.completeOnboarding();
              }}
            />
            <Small>기록 기능은 기본적으로 꺼져 있습니다. 필요 시 설정에서 직접 켜 주십시오.</Small>
          </>
        ) : null}

        {step > 0 && step < 3 ? (
          <Button label="이전" onPress={() => setStep((s) => s - 1)} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
