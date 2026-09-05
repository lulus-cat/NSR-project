import { useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Body, Button, Card, Heading, Small } from "../src/components/ui";
import { useApp } from "../src/state/AppContext";
import { TOUCH_MIN, radius, space, type, useTheme } from "../src/theme";
import { getSetting, setSetting } from "../src/db";
import { SETTINGS_KEYS } from "../src/services/scheduler";
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
    key: "tiro",
    title: "티로 (한국어 전용, 추천)",
    body: "열쇠 하나만 넣으면 돼요. 한국어를 가장 잘 받아적었어요. 열쇠 받는 길은 설정에서 알려드려요.",
  },
  {
    key: "colab",
    title: "구글 콜랩 (무료 GPU, 휘스퍼)",
    body: "컴퓨터 없이 무료로 돌아가요. 준비는 3분쯤 걸려요. 잇는 법은 설정에서 알려드려요.",
  },
  {
    key: "pc",
    title: "내 컴퓨터 (PC·노트북)",
    body: "같은 Wi-Fi 의 내 컴퓨터가 바꿔요. 녹음이 집 밖으로 나가지 않아요.",
  },
  {
    key: "gemini",
    title: "Gemini (구글 AI)",
    body: "열쇠 하나면 콜랩도 컴퓨터도 필요 없어요. 열쇠 받는 길은 설정에서 알려드려요.",
  },
  {
    key: "later",
    title: "나중에 정하기",
    body: "지금 건너뛰어도 나중에 설정에서 정하면 돼요.",
  },
] as const;

const ITEMS: { key: string; title: string; body: string }[] = [
  {
    key: "wiretap",
    title: "당사자가 아닌 타인 간 대화 기록 금지",
    body:
      "내가 끼지 않은 대화를 녹음하면 불법이에요. 자리를 비울 때는 기록을 끄고 폰을 꼭 들고 다녀요.",
  },
  {
    key: "medical",
    title: "기록 내 민감 정보 포함 주의",
    body:
      "환자 정보를 흘리면 의료법 위반이에요. 기록은 폰 안에서 다뤄요.",
  },
  {
    key: "hospital",
    title: "원내 규정에 따른 기록 금지 확인",
    body:
      "몰래 녹음하면 병원 규정 위반이 될 수 있어요. 병원 내규를 먼저 확인해요.",
  },
  {
    key: "indicator",
    title: "OS 마이크 상태 표시 안내",
    body:
      "녹음 중 마이크 표시는 폰이 켜는 거라 숨길 수 없어요. 앱이 소리를 내지는 않아요.",
  },
  {
    key: "score",
    title: "온도는 판정이 아니라 기록이에요",
    body:
      "점수는 참고용이에요. 말투는 담기지 않으니 실제 문장을 꼭 직접 봐요.",
  },
  {
    key: "device",
    title: "기기 분실 시 데이터 유출 주의",
    body:
      "폰을 잃어버릴 때를 대비해 앱 잠금을 켜요. 오래된 파일은 저절로 지워져요.",
  },
  {
    key: "alpha",
    title: "알파 버전 안내",
    body:
      "아직 시험 판이라 기능이 바뀔 수 있어요. 중요한 기록은 따로 챙겨 둬요.",
  },
];

const STEPS = ["근무지", "파트", "전사 방식", "필수 확인"];

/**
 * 고르던 값을 화면 밖에 남긴다.
 *
 * 삼성 DeX 처럼 창 크기·밀도가 바뀌는 환경에서는 안드로이드가 액티비티를 다시
 * 만들 수 있고, 그러면 이 화면의 useState 가 전부 초기값으로 돌아간다. 몇 단계를
 * 채워 놓고 처음으로 튕기는 것이 그동안 "다음이 안 눌린다"로 보였다. 모듈에
 * 남겨 두면 다시 마운트돼도 이어서 진행된다.
 */
const draft: { step: number; part: string | null; model: string | null } = {
  step: 0,
  part: null,
  model: null,
};

export default function Onboarding() {
  const t = useTheme();
  const app = useApp();
  const [step, setStep] = useState(draft.step);
  // AI 필수 설정 — 조합과 키 두 개가 저장돼야 다음으로 갈 수 있다.
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
  const [part, setPart] = useState<string | null>(draft.part);
  // 3단계 — 모델
  const [model, setModel] = useState<string | null>(draft.model);
  // 저장이 실패해도 화면은 넘어간다. 대신 무슨 일이 있었는지는 알린다.
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    draft.step = step;
    draft.part = part;
    draft.model = model;
  }, [step, part, model]);

  // 마지막 단계 — 고지
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [micGranted, setMicGranted] = useState(false);
  const [locGranted, setLocGranted] = useState(false);
  const [starting, setStarting] = useState(false);
  const allChecked = ITEMS.every((i) => checked[i.key]);

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  /**
   * 저장은 화면 전환을 막지 않는다.
   *
   * 예전에는 버튼이 `await 저장()` 뒤에 다음 단계로 넘어갔다. 저장이 늦거나
   * 실패하면 버튼을 눌러도 아무 일이 안 일어난 것처럼 보였다. 이제 저장은 뒤로
   * 보내고, 잘못되면 그 자리에서 말로 알린다.
   */
  const save = async (run: () => Promise<unknown>) => {
    try {
      await run();
      setSaveMsg(null);
    } catch (e) {
      setSaveMsg("방금 고른 값을 저장하지 못했어요. 설정 화면에서 다시 정해 주세요.");
    }
  };

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
  근무하는 병원을 골라요
</Text>
            <Small>
              근무지를 정하면 병원에 들어설 때 기록이 켜지고 나올 때 꺼져요. 찾는 말만
              지도로 가고, 내 위치는 보내지 않아요.
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
                          ? "찾지 못했어요. 지점 이름을 빼고 다시 찾아 주세요."
                          : "찾지 못했어요. 병원 정식 이름으로 다시 찾아 주세요."
                        : null,
                    );
                  } catch (e) {
                    setSearchMsg(e instanceof Error ? e.message : "찾지 못했어요. 인터넷 연결을 확인해 주세요.");
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
              onPress={() => {
                // 저장을 기다리지 않는다 — 저장이 늦거나 실패해도 화면은 넘어가야 한다.
                if (picked) void save(() => setWorkplacePlace(picked));
                next();
              }}
            />
          </>
        ) : null}

        {/* ── 2. 파트 ── */}
        {step === 1 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>
  근무 파트를 골라요
</Text>
            <Small>
  고른 파트의 말이 사전에서 먼저 나와요.
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
              onPress={() => {
                if (part) void save(() => setSetting("profile.part", part));
                next();
              }}
            />
          </>
        ) : null}

        {/* ── 3. 전사 방식 ── */}
        {step === 2 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>
  어디서 글자로 바꿀까요
</Text>
            <Small>
              글자로 바꾸는 일은 폰이 아니라 아래 넷 중 한 곳이 해요. 녹음한 소리가 고른
              곳으로 전송돼요. 나중에 설정에서 바꿀 수 있어요.
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
              onPress={() => {
                if (
                  model === "tiro" ||
                  model === "colab" ||
                  model === "pc" ||
                  model === "gemini"
                ) {
                  // 설정 → 전사 화면이 이 모드로 열린다. 주소는 거기서 잇는다.
                  // 통째로 덮어쓰면 이미 고른 모델·화자 분리·주소가 날아간다.
                  void save(async () => {
                    const prev = await getSetting<Record<string, unknown>>(
                      SETTINGS_KEYS.cloudTranscription,
                      {},
                    );
                    await setSetting(SETTINGS_KEYS.cloudTranscription, {
                      ...prev,
                      enabled: false,
                      endpoint: "",
                      mode: model,
                    });
                  });
                }
                next();
              }}
            />
            {saveMsg ? <Small muted={false}>{saveMsg}</Small> : null}
          </>
        ) : null}

        {step === 3 ? (
          <>
            <Text style={[type.title, { color: t.text }]}>시작하기 전에</Text>
            <Small>
  모든 항목을 읽고 눌러 주세요.
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
                마이크는 꼭 필요해요. 위치는 근무지 자동 기록을 쓸 때만 필요하고, 나중에
                설정에서 켤 수 있어요.
              </Small>
              <Button
                label={micGranted ? "마이크 켜짐" : "마이크 켜기"}
                tone={micGranted ? "default" : "primary"}
                onPress={async () => {
                  const r = await requestRecordingPermissionsAsync();
                  setMicGranted(r.granted);
                }}
              />
              <Button
                label={locGranted ? "위치 켜짐" : "위치 켜기"}
                onPress={async () => {
                  const r = await Location.requestForegroundPermissionsAsync();
                  setLocGranted(r.granted);
                }}
              />
            </Card>

            <Button
              label={starting ? "준비 중" : allChecked ? "시작하기" : "항목 모두 확인"}
              tone="primary"
              disabled={!allChecked || starting}
              busy={starting}
              onPress={() => {
                setStarting(true);
                void app.completeOnboarding();
              }}
            />
            <Small>기록 기능은 처음에 꺼져 있어요. 설정에서 켜요.</Small>
          </>
        ) : null}

        {step > 0 && step < 4 ? (
          <Button label="이전" onPress={() => setStep((s) => s - 1)} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
