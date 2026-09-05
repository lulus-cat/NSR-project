/**
 * 전사 설정 — 어디서(콜랩/내 컴퓨터/Gemini), 어떤 모델로 전사할지 고르는 화면.
 *
 * 폰 전사는 없앴다. 8시간 근무 기록을 폰이 삭이려면 몇 시간씩 걸리고
 * 뜨거워지는데, 그 시간을 견딜 만큼 정확하지도 않았다. 남은 경로는 셋이고,
 * 이 화면의 첫 번째 일은 **서로 헷갈리지 않게 가르는 것**이다 —
 * 예전엔 한 카드에 도커·콜랩·모델 버튼이 뒤섞여 있어서, 콜랩을 쓰는
 * 사람이 PC 용 버튼을 누르고 왜 안 바뀌는지 알 수 없었다. Gemini 는
 * 휘스퍼 서버와 아예 다른 물건이라 카드 자체를 따로 두었다.
 *
 * 모델 선택은 모드와 무관하게 같은 문법이다: 목록에서 누르면 그 모델이
 * 선택되고, 다음 전사 요청에 model 파라미터로 실려 간다. 콜랩 노트는
 * 이 파라미터를 읽어 필요하면 모델을 갈아끼운다.
 */
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps } from "react";
import {
  DEFAULT_COLAB_MODEL_ID,
  serverModelsFor,
  type ServerAsrModel,
} from "@nsr/core";
import { Badge, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { CONTENT_MAX, TOUCH_MIN, radius, space, type, useTheme } from "../src/theme";
import { getSetting, setSetting } from "../src/db";
import { getApiKey, migrateRetiredModel, setApiKey } from "../src/services/llm";
import {
  getHfToken,
  setHfToken,
  getTiroKey,
  setTiroKey,
  checkTiroConnection,
  syncTiroWordMemory,
  loadLexicon,
} from "../src/services/asr";
import { SETTINGS_KEYS } from "../src/services/scheduler";

type ServerMode = "colab" | "pc" | "gemini" | "tiro";

interface ServerAsr {
  enabled: boolean;
  /** 지금 쓰는 주소. 전사(resolveProvider)는 이 값만 본다. */
  endpoint: string;
  model?: string;
  mode?: ServerMode;
  /** 모드별로 기억해 두는 주소 — 모드를 오가도 붙여넣은 주소가 안 날아간다. */
  endpoints?: Partial<Record<ServerMode, string>>;
  /**
   * 모드별로 기억해 두는 모델. 콜랩 전용 미러와 허깅페이스 공개판은 서로 다른
   * 목록이라, 모드를 오갔다고 고른 모델이 사라지면 화면은 기본 모델을 가리키는데
   * 서버는 다른 것을 받는 어긋남이 생긴다.
   */
  models?: Partial<Record<ServerMode, string>>;
  /** Gemini 직접 전사에서 쓸 모델 id. 휘스퍼 모델(model)과는 다른 세계라 따로 둔다. */
  geminiModel?: string;
  /** 화자 분리(pyannote) — 콜랩 노트만 지원한다. 토큰은 보안 저장소에 따로 둔다. */
  diarize?: boolean;
}

/**
 * 콜랩 노트 주소. 이 브랜치의 노트를 가리켜야 앱과 노트가 같은 판으로 논다 —
 * 드라이브 사본이 아니라 이 링크로 열어야 최신판이다.
 */
const COLAB_NOTEBOOK_URL =
  "https://colab.research.google.com/github/lulus-cat/NSR-project/blob/claude/transcription-model-ui-niyqxa/docs/colab/nsr-transcribe-server.ipynb";

/** 저장된 설정에 mode 가 없던 옛 판 사용자 — 주소 생김새로 짐작한다. */
function inferMode(server: ServerAsr): ServerMode {
  if (server.mode) return server.mode;
  if (server.endpoint) return server.endpoint.includes("trycloudflare.com") ? "colab" : "pc";
  // 주소도 모드도 없는 새 사용자 — 티로가 기본이다. 같은 녹음을 네 엔진으로
  // 돌려 보니 한국어 정확도가 가장 좋았다 (티로 > 클로바노트 > 다글로 > 휘스퍼).
  return "tiro";
}

/** 전사 방식 타일 — 콜랩/내 컴퓨터를 한눈에 가르는 큰 선택지. */
function ModeTile({
  icon,
  title,
  caption,
  selected,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>["name"];
  title: string;
  caption: string;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        // 폰에서 넷을 한 줄에 늘어놓으면 "Gemi/ni" 처럼 글자가 잘린다.
        // 두 개씩 두 줄로 접히게 두고, 넓은 화면에서만 한 줄이 된다.
        flexGrow: 1,
        flexBasis: "46%",
        minWidth: 150,
        minHeight: 96,
        borderRadius: radius.lg,
        borderWidth: 2,
        borderColor: selected ? t.accent : "transparent",
        backgroundColor: selected ? t.accentSoft : t.surfaceAlt,
        padding: space.md,
        gap: space.xs,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Ionicons name={icon} size={20} color={selected ? t.accent : t.textMuted} />
        {selected ? <Badge text="사용 중" tone="ok" /> : null}
      </View>
      <Text style={[type.heading, { color: t.text }]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={[type.small, { color: t.textMuted, fontWeight: "600" }]} numberOfLines={2}>
        {caption}
      </Text>
    </Pressable>
  );
}

/**
 * 모델 한 줄 — 누르면 그 모델이 선택된다.
 * 설명은 딱 한 문장(한국어 정확도 + 특징)만 둔다. 표가 길어지면 안 읽는다.
 */
function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: ServerAsrModel;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onSelect}
      style={({ pressed }) => ({
        minHeight: TOUCH_MIN,
        borderRadius: radius.md,
        backgroundColor: selected ? t.accentSoft : pressed ? t.surfaceAlt : "transparent",
        padding: space.md,
        gap: space.xs,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={[type.body, { color: t.text, fontWeight: "700", flexShrink: 1 }]}>
          {model.name}
        </Text>
        {selected ? (
          <Badge text="선택됨" tone="ok" />
        ) : (
          <Text style={[type.small, { color: t.textMuted, fontWeight: "600" }]}>선택</Text>
        )}
      </View>
      <Small>{model.summary}</Small>
    </Pressable>
  );
}

export default function TranscriptionSetup() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [server, setServer] = useState<ServerAsr>({ enabled: false, endpoint: "" });
  const [check, setCheck] = useState<
    { state: "idle" } | { state: "checking" } | { state: "done"; ok: boolean; message: string }
  >({ state: "idle" });
  // Gemini 키 — 보조 기능과 같은 보안 저장소 항목을 쓴다(구글 AI 키는 하나).
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [tiroKeyInput, setTiroKeyInput] = useState("");
  const [hasTiroKey, setHasTiroKey] = useState(false);
  const [wordSync, setWordSync] = useState<string | null>(null);
  // 화자 분리 토큰 — 앱에서 받아 전사 요청에 실어 보낸다(콜랩에서 설정하지 않는다).
  const [hasHfToken, setHasHfToken] = useState(false);
  const [hfTokenInput, setHfTokenInput] = useState("");
  useEffect(() => {
    void (async () => {
      const saved = await getSetting<ServerAsr>(SETTINGS_KEYS.cloudTranscription, {
        enabled: false,
        endpoint: "",
      });
      // 옛 판 설정에는 모드별 기억이 없다 — 지금 주소를 지금 모드 것으로 심는다.
      const m = inferMode(saved);
      const endpoints = { ...saved.endpoints };
      if (saved.endpoint && !endpoints[m]) endpoints[m] = saved.endpoint;
      // 단종된 Gemini 모델이 저장돼 있으면 화면에서도 현행 모델로 바꿔 보여준다.
      const geminiModel = saved.geminiModel
        ? migrateRetiredModel(saved.geminiModel.trim())
        : saved.geminiModel;
      setServer({ ...saved, mode: m, endpoints, geminiModel });
      setHasGeminiKey((await getApiKey("gemini")) !== null);
      setHasTiroKey((await getTiroKey()) !== null);
      setHasHfToken((await getHfToken()) !== null);
    })();
  }, []);

  const save = useCallback(async (next: ServerAsr) => {
    // 켜고 끄는 스위치는 없다 — 전사 경로가 서버뿐이라 주소가 있으면 켜진 것이다.
    const stored = { ...next, enabled: next.endpoint.trim().length > 0 };
    setServer(stored);
    await setSetting(SETTINGS_KEYS.cloudTranscription, stored);
  }, []);


  const mode = inferMode(server);
  // 티로·제미나이는 키만 있으면 되는 모드다 — 서버 주소도 모델 선택도 없다.
  const keyOnly = mode === "gemini" || mode === "tiro";
  const models = keyOnly ? [] : serverModelsFor(mode);
  // 콜랩은 비워 둬도 노트 기본값이 같은 모델이라, 화면에서는 기본 모델이 선택된 것으로 보여준다.
  const selectedModelId =
    server.model ?? (mode === "colab" ? DEFAULT_COLAB_MODEL_ID : undefined);

  const setEndpoint = useCallback(
    (endpoint: string) => {
      void save({
        ...server,
        endpoint,
        endpoints: { ...server.endpoints, [mode]: endpoint },
      });
    },
    [mode, save, server],
  );

  const switchMode = useCallback(
    (nextMode: ServerMode) => {
      if (nextMode === mode) return;
      setCheck({ state: "idle" });
      // 주소는 모드마다 다른 물건이다(터널 주소 vs 집 IP). 콜랩 주소로 PC
      // 전사를 시도하는 헛걸음이 없도록, 그 모드에서 마지막으로 쓰던 주소로
      // 갈아끼운다. 모델도 모드 목록에 없는 것이면 비운다.
      const usable = (id?: string) =>
        nextMode !== "gemini" && nextMode !== "tiro" && id && serverModelsFor(nextMode).some((m) => m.id === id)
          ? id
          : undefined;
      const keepModel = usable(server.models?.[nextMode]) ?? usable(server.model);
      void save({
        ...server,
        endpoint: server.endpoints?.[nextMode] ?? "",
        model: keepModel,
        // 떠나는 모드의 선택은 남겨 둔다 — 돌아오면 그대로 되살아난다.
        models:
          keyOnly ? server.models : { ...server.models, [mode]: server.model },
        mode: nextMode,
      });
    },
    [mode, save, server],
  );

  /** 화자 분리 토큰 저장·삭제. 보안 저장소에만 남고, 전사 요청에만 실린다. */
  const saveHfKey = useCallback(
    async (raw?: string) => {
      const token = (raw ?? hfTokenInput).trim();
      await setHfToken(token || null);
      setHasHfToken(token.length > 0);
      setHfTokenInput("");
    },
    [hfTokenInput],
  );

  const saveGeminiKey = useCallback(async () => {
    const key = geminiKeyInput.trim();
    if (!key) {
      setCheck({ state: "done", ok: false, message: "열쇠를 먼저 위 칸에 붙여넣어 주세요." });
      return;
    }
    try {
      await setApiKey(key, "gemini");
      setHasGeminiKey(true);
      setGeminiKeyInput("");
      setCheck({ state: "done", ok: true, message: "열쇠를 이 폰에 넣었어요." });
    } catch (e) {
      setCheck({
        state: "done",
        ok: false,
        message: e instanceof Error ? e.message : "열쇠를 저장하지 못했어요. 다시 눌러 주세요.",
      });
    }
  }, [geminiKeyInput]);

  const clearTiroKey = useCallback(async () => {
    await setTiroKey(null);
    setHasTiroKey(false);
    setTiroKeyInput("");
    setWordSync(null);
  }, []);

  const clearGeminiKey = useCallback(async () => {
    await setApiKey(null, "gemini");
    setHasGeminiKey(false);
    setGeminiKeyInput("");
    setCheck({ state: "done", ok: false, message: "열쇠를 지웠어요." });
  }, []);

  const saveTiroKey = useCallback(async () => {
    const key = tiroKeyInput.trim();
    // 잠긴 버튼은 왜 안 되는지 말해 주지 않는다. 눌리게 두고 이유를 적는다.
    if (!key) {
      setCheck({ state: "done", ok: false, message: "열쇠를 먼저 위 칸에 붙여넣어 주세요." });
      return;
    }
    try {
      await setTiroKey(key);
      setHasTiroKey(true);
      setTiroKeyInput("");
      setCheck({ state: "done", ok: true, message: "열쇠를 넣었어요. 아래 '연결 확인'을 눌러 보세요." });
    } catch (e) {
      setCheck({
        state: "done",
        ok: false,
        message: e instanceof Error ? e.message : "열쇠를 저장하지 못했어요. 다시 눌러 주세요.",
      });
    }
  }, [tiroKeyInput]);

  const checkTiro = useCallback(async () => {
    setCheck({ state: "checking" });
    const r = await checkTiroConnection();
    setCheck({ state: "done", ok: r.ok, message: r.message });
  }, []);

  const pushWordMemory = useCallback(async () => {
    setWordSync("사전 올리는 중");
    try {
      const lexicon = await loadLexicon();
      const r = await syncTiroWordMemory(lexicon, (done, total) =>
        setWordSync(`사전 올리는 중… ${done}/${total}`),
      );
      setWordSync(
        `새로 ${r.added}개 · 이미 있던 것 ${r.already}개` +
          (r.skipped ? ` · 띄어쓰기가 있어 못 올린 것 ${r.skipped}개` : "") +
          (r.failed ? ` · 실패 ${r.failed}개` : ""),
      );
    } catch (e) {
      setWordSync(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const checkGemini = useCallback(async () => {
    const key = await getApiKey("gemini");
    if (!key) {
      setCheck({ state: "done", ok: false, message: "열쇠가 없어요. 위 칸에 넣고 저장해 주세요." });
      return;
    }
    setCheck({ state: "checking" });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${key}`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      setCheck(
        res.ok
          ? { state: "done", ok: true, message: "연결됐어요. 근무 기록 화면에서 녹음을 바꿔 보세요." }
          : { state: "done", ok: false, message: "열쇠가 맞지 않아요. 열쇠를 다시 확인해 주세요." },
      );
    } catch {
      setCheck({ state: "done", ok: false, message: "구글에 닿지 못했어요. 인터넷 연결을 확인해 주세요." });
    }
  }, []);

  const checkConnection = useCallback(async () => {
    const base = server.endpoint.trim().replace(/\/+$/, "");
    if (!base) {
      setCheck({ state: "done", ok: false, message: "주소가 없어요. 위 칸에 붙여넣어 주세요." });
      return;
    }
    setCheck({ state: "checking" });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timer);
      setCheck(
        res.ok
          ? { state: "done", ok: true, message: "연결됐어요. 근무 기록 화면에서 녹음을 바꿔 보세요." }
          : {
              state: "done",
              ok: false,
              message: "주소가 맞지 않아요. 주소를 끝까지 붙여넣었는지 확인해 주세요.",
            },
      );
    } catch {
      setCheck({
        state: "done",
        ok: false,
        message:
          mode === "colab"
            ? "연결하지 못했어요. 콜랩 노트를 '모두 실행' 했는지 확인해 주세요."
            : "연결하지 못했어요. 폰과 컴퓨터가 같은 Wi-Fi인지 확인해 주세요.",
      });
    }
  }, [mode, server.endpoint]);

  const input = {
    color: t.text,
    backgroundColor: t.surfaceAlt,
    borderRadius: radius.md,
    padding: space.md,
    fontSize: 14,
  };

  return (
    <ScrollView
      // 키보드가 떠 있으면 첫 탭이 버튼이 아니라 키보드 닫기에 먹힌다. 열쇠를
      // 붙여넣고 바로 '열쇠 저장'을 눌렀을 때 아무 일도 안 일어나던 이유다.
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        padding: space.lg,
        // 안드로이드 내비게이션 바가 마지막 카드를 가리지 않게 안전영역만큼 띄운다.
        paddingBottom: space.lg + insets.bottom,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
    >
      {/* ── 방식 선택: 이 화면의 첫 질문 ── */}
      <Card>
        <Heading>어디서 글자로 바꿀까요</Heading>
        <Small>글자로 바꾸는 일은 폰이 아니라 아래 넷 중 한 곳이 해요.</Small>
        <Small>기본은 티로예요. 한국어를 가장 잘 받아적었어요.</Small>
        <Small>녹음한 소리가 고른 곳으로 전송돼요.</Small>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <ModeTile
            icon="mic-outline"
            title="티로"
            caption="한국어 전용 · 추천"
            selected={mode === "tiro"}
            onPress={() => switchMode("tiro")}
          />
          <ModeTile
            icon="logo-google"
            title="콜랩"
            caption="무료 · 준비 3분"
            selected={mode === "colab"}
            onPress={() => switchMode("colab")}
          />
          <ModeTile
            icon="laptop-outline"
            title="내 컴퓨터"
            caption="집 밖으로 안 나감"
            selected={mode === "pc"}
            onPress={() => switchMode("pc")}
          />
          <ModeTile
            icon="sparkles-outline"
            title="Gemini"
            caption="열쇠 하나로"
            selected={mode === "gemini"}
            onPress={() => switchMode("gemini")}
          />
        </View>
      </Card>

      {/* ── 화자 분리 — 콜랩 전용. 토큰까지 여기서 받는다(콜랩엔 설정 없음) ── */}
      {mode === "colab" ? (
        <Card>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: TOUCH_MIN,
            }}
          >
            <Text style={[type.body, { color: t.text, fontWeight: "600" }]}>목소리 나누기</Text>
            <Switch
              value={!!server.diarize}
              onValueChange={(v) => void save({ ...server, diarize: v })}
            />
          </View>
          <Small>누가 말했는지 목소리별로 자동으로 나눠요.</Small>
          <Small>결과 화면에서 목소리마다 역할을 한 번에 정해요.</Small>
          <Small>대신 몇 분 더 걸려요.</Small>
          <Divider />
          <Small muted={false}>
            허깅페이스 열쇠{hasHfToken ? " — 넣어 뒀어요" : " — 아직 없어요"}
          </Small>
          <Small>목소리를 나누는 기능은 무료예요.</Small>
          <Small>대신 허깅페이스 가입 확인이 필요해요.</Small>
          <Small>열쇠는 이 폰 안에만 남아요.</Small>
          <TextInput
            value={hfTokenInput}
            onChangeText={setHfTokenInput}
            placeholder={hasHfToken ? "넣어 둔 열쇠가 있어요" : "hf_ 로 시작하는 Read 열쇠"}
            placeholderTextColor={t.textMuted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              color: t.text,
              backgroundColor: t.surfaceAlt,
              borderRadius: radius.md,
              padding: space.md,
              minHeight: TOUCH_MIN,
              fontSize: 14,
            }}
          />
          <Button
            label="열쇠 저장"
            tone={hasHfToken ? "default" : "primary"}
            onPress={() => void saveHfKey()}
          />
          {hasHfToken ? (
            <Button label="열쇠 지우기" onPress={() => void saveHfKey("")} />
          ) : null}
          <Divider />
          <Small muted={false}>열쇠 만들기 — 무료, 한 번만 (약 5분)</Small>
          <Small>누르면 각 쪽이 열려요.</Small>
          <Small>로그인한 뒤 Agree(동의)를 한 번씩 눌러요.</Small>
          <Button
            label="1. 모델 동의 열기"
            onPress={() =>
              void Linking.openURL(
                "https://huggingface.co/pyannote/speaker-diarization-community-1",
              )
            }
          />
          <Button
            label="2. 예비 모델 동의 열기"
            onPress={() =>
              void Linking.openURL("https://huggingface.co/pyannote/speaker-diarization-3.1")
            }
          />
          <Button
            label="3. 구간 모델 동의 열기"
            onPress={() =>
              void Linking.openURL("https://huggingface.co/pyannote/segmentation-3.0")
            }
          />
          <Button
            label="4. 열쇠 발급 열기"
            onPress={() => void Linking.openURL("https://huggingface.co/settings/tokens")}
          />
          <Small>열쇠 없이 켜도 글자로는 바뀌어요. 목소리만 안 나뉘어요.</Small>
        </Card>
      ) : null}

      {/* ── 모델 선택(휘스퍼 경로): 콜랩·PC 는 같은 문법, Gemini 는 자기 카드에서 ── */}
      {!keyOnly ? (
      <Card>
        <Heading>전사 모델</Heading>
        <Small>누르면 다음부터 그 모델로 바꿔요.</Small>
        <Small>처음 쓰는 모델은 준비하느라 몇 분 더 걸려요.</Small>
        <Small>폰에는 아무것도 내려받지 않아요.</Small>
        <Divider />
        {models.map((m, i) => (
          <View key={m.id}>
            {i > 0 ? <Divider /> : null}
            <ModelRow
              model={m}
              selected={selectedModelId === m.id}
              onSelect={() =>
                void save({
                  ...server,
                  model: m.id,
                  models: { ...server.models, [mode]: m.id },
                })
              }
            />
          </View>
        ))}
        {mode === "pc" ? (
          <>
            <Divider />
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: selectedModelId === undefined }}
              onPress={() =>
                void save({
                  ...server,
                  model: undefined,
                  models: { ...server.models, [mode]: undefined },
                })
              }
              style={({ pressed }) => ({
                minHeight: TOUCH_MIN,
                borderRadius: radius.md,
                backgroundColor:
                  selectedModelId === undefined
                    ? t.accentSoft
                    : pressed
                      ? t.surfaceAlt
                      : "transparent",
                padding: space.md,
                gap: space.xs,
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={[type.body, { color: t.text, fontWeight: "700" }]}>기본 모델</Text>
                {selectedModelId === undefined ? (
                  <Badge text="선택됨" tone="ok" />
                ) : (
                  <Text style={[type.small, { color: t.textMuted, fontWeight: "600" }]}>선택</Text>
                )}
              </View>
              <Small>고르지 않고 미리 준비된 모델을 그대로 써요.</Small>
            </Pressable>
          </>
        ) : null}
      </Card>

      ) : null}

      {/* ── 선택한 방식의 연결 ── */}
      {mode === "colab" ? (
        <Card tone="accent">
          <Heading>콜랩 잇기</Heading>
          <Small>녹음한 소리가 구글 콜랩을 지나가요. 내 컴퓨터가 아니에요.</Small>
          <Small>바꾸는 동안 콜랩 탭을 열어 둬요.</Small>
          <Small>탭을 닫으면 콜랩도 꺼져요.</Small>
          <Divider />
          <Small muted={false}>1. 콜랩 노트를 열고 &lsquo;런타임 → 모두 실행&rsquo;</Small>
          <Button label="콜랩 노트 열기" tone="primary" onPress={() => void Linking.openURL(COLAB_NOTEBOOK_URL)} />
          <Small muted={false}>
            2. 마지막 칸의 &lsquo;NSR 앱에 연결&rsquo; 버튼을 누르면 주소가 저장돼요
          </Small>
          <Small>버튼이 안 되면 주소를 복사해 아래에 붙여넣어요.</Small>
          <Small>콜랩에서 고칠 것은 없어요. 모두 이 화면에서 정해요.</Small>
          <TextInput
            value={server.endpoint}
            onChangeText={setEndpoint}
            placeholder="https://….trycloudflare.com/비밀문자열"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={input}
          />
          <Small>콜랩을 껐다 켜면 주소가 새로 나와요.</Small>
          <Small>그때마다 다시 붙여넣어요.</Small>
          <Button
            label={check.state === "checking" ? "확인 중" : "연결 확인"}
            busy={check.state === "checking"}
            onPress={() => void checkConnection()}
          />
          {check.state === "done" ? (
            <Text style={[type.small, { color: check.ok ? t.ok : t.danger, fontWeight: "600" }]}>
              {check.message}
            </Text>
          ) : null}
        </Card>
      ) : mode === "pc" ? (
        <Card tone="accent">
          <Heading>내 컴퓨터 잇기</Heading>
          <Small>같은 Wi-Fi 의 내 컴퓨터가 글자로 바꿔요.</Small>
          <Small>소리가 그 컴퓨터로만 가요. 내 컴퓨터에만 이어요.</Small>
          <Divider />
          <Small muted={false}>1. 컴퓨터에 한 번만: Docker 를 깔고 아래를 붙여넣어요</Small>
          <View style={{ backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
            <Text selectable style={{ color: t.text, fontFamily: "monospace", fontSize: 12 }}>
              docker run -d -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
            </Text>
          </View>
          <Small muted={false}>2. 컴퓨터의 Wi-Fi 주소를 아래에 넣어요</Small>
          <TextInput
            value={server.endpoint}
            onChangeText={setEndpoint}
            placeholder="http://192.168.0.10:8000"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={input}
          />
          <Small>집 밖에서도 쓰려면 Tailscale 이 가장 쉬워요.</Small>
          <Button
            label={check.state === "checking" ? "확인 중" : "연결 확인"}
            busy={check.state === "checking"}
            onPress={() => void checkConnection()}
          />
          {check.state === "done" ? (
            <Text style={[type.small, { color: check.ok ? t.ok : t.danger, fontWeight: "600" }]}>
              {check.message}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {/* ── Gemini 직접 전사 — 휘스퍼와 다른 세계라 설정도 따로 논다 ── */}
      {mode === "tiro" ? (
        <Card tone="accent">
          <Heading>티로로 바꾸기</Heading>
          <Small>열쇠 하나만 넣으면 돼요.</Small>
          <Small>한국어 전용이라 병동 대화에 강해요.</Small>
          <Small>문장마다 실제 시각과 목소리 구분이 함께 와요.</Small>
          <Small>한 시간짜리 하나에 3~6분쯤 걸려요.</Small>
          <Small>긴 녹음은 3시간씩 나눠서 보내요.</Small>
          <Divider />
          <Small muted={false}>알고 써요</Small>
          <Small>녹음한 소리가 티로로 전송돼요.</Small>
          <Small>병동 음성이니 티로의 보관 정책을 한 번 확인해요.</Small>
          <Small>티로가 계정에 파일 전사를 켜 줘야 돼요.</Small>
          <Divider />
          <Small muted={false}>파일 전사가 안 켜졌을 때</Small>
          <Small>티로 앱으로 녹음하고 글자만 가져오면 돼요.</Small>
          <Button label="노트 가져오기" onPress={() => router.push("/tiro-notes")} />
          <Divider />
          <Small muted={false}>열쇠{hasTiroKey ? " — 넣어 뒀어요" : " — 아직 없어요"}</Small>
          <Button
            label="열쇠 받으러 가기"
            onPress={() => void Linking.openURL("https://docs.tiro.ooo/ko/developers/")}
          />
          <TextInput
            value={tiroKeyInput}
            onChangeText={setTiroKeyInput}
            placeholder="아이디.비밀문자 모양의 열쇠"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={input}
          />
          {/* 저장과 지우기를 한 버튼에 두면, 저장한 뒤 한 번 더 누른 사람이
              열쇠를 지우게 된다. 실제로 그렇게 열쇠가 사라졌다. 이제 가른다. */}
          <Button label="열쇠 저장" tone="primary" onPress={() => void saveTiroKey()} />
          {hasTiroKey ? <Button label="열쇠 지우기" onPress={() => void clearTiroKey()} /> : null}
          <Small>열쇠는 이 폰 안에만 남아요.</Small>
          <Button
            label={check.state === "checking" ? "확인 중" : "연결 확인"}
            busy={check.state === "checking"}
            onPress={() => void checkTiro()}
          />
          {check.state === "done" ? (
            <Text style={[type.small, { color: check.ok ? t.ok : t.danger, fontWeight: "600" }]}>
              {check.message}
            </Text>
          ) : null}
          <Divider />
          <Small muted={false}>병동 사전 자동 맞추기</Small>
          <Small>티로로 바꿀 때마다 새 단어만 자동으로 올라가요.</Small>
          <Small>아래 버튼은 지금 바로 맞추고 싶을 때만 눌러요.</Small>
          <Small>직접 넣은 병동 말도 함께 올라가요.</Small>
          <Small>환자 이름처럼 사람을 알아볼 말은 사전에 넣지 마세요.</Small>
          <Button label="지금 맞추기" onPress={() => void pushWordMemory()} />
          {wordSync ? <Small>{wordSync}</Small> : null}
        </Card>
      ) : null}

      {mode === "gemini" ? (
        <Card tone="accent">
          <Heading>Gemini 로 바꾸기</Heading>
          <Small>구글 AI 열쇠 하나만 넣으면 돼요.</Small>
          <Small>보통 모델은 시각이 어림값이라 재생이 몇 초 어긋나요.</Small>
          <Small>전사 전용 모델은 시각이 정확해요.</Small>
          <Divider />
          <Small muted={false}>알고 써요</Small>
          <Small>녹음한 소리가 구글로 전송돼요.</Small>
          <Small>무료 열쇠는 보낸 내용이 구글 학습에 쓰일 수 있어요.</Small>
          <Small>병동 음성이라면 결제를 연결한 열쇠를 권해요.</Small>
          <Small>올린 파일은 바뀐 뒤에 앱이 지워요.</Small>
          <Divider />
          <Small muted={false}>
            1. 열쇠{hasGeminiKey ? " — 넣어 뒀어요" : " — 아직 없어요"}
          </Small>
          <Button
            label="열쇠 받으러 가기"
            onPress={() => void Linking.openURL("https://aistudio.google.com/apikey")}
          />
          <TextInput
            value={geminiKeyInput}
            onChangeText={setGeminiKeyInput}
            placeholder="AIza… 로 시작하는 열쇠"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={input}
          />
          <Button label="열쇠 저장" tone="primary" onPress={() => void saveGeminiKey()} />
          {hasGeminiKey ? (
            <Button label="열쇠 지우기" onPress={() => void clearGeminiKey()} />
          ) : null}
          <Small>
            키는 기기 보안 저장소에만 보관되고, 설정 → 보조 기능의 Gemini 와 같은
            열쇠를 써요.
          </Small>
          <Divider />
          <Small muted={false}>2. 모델</Small>
          <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
            {[
              ["gemini-3.8-flash", "기본 — 긴 기록도 통짜로"],
              ["gemini-3.5-transcribe", "전문 전사 — 30분 이하"],
              ["gemini-3.1-pro-preview", "가장 정확 — 유료 키 전용"],
            ].map(([id, hint]) => {
              const on = (server.geminiModel?.trim() || "gemini-3.8-flash") === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => void save({ ...server, geminiModel: id })}
                  style={{
                    paddingVertical: space.xs,
                    paddingHorizontal: space.md,
                    borderRadius: radius.sm,
                    backgroundColor: on ? t.accent : t.surfaceAlt,
                    minHeight: 36,
                    justifyContent: "center",
                  }}
                >
                  <Text style={[type.caption, { color: on ? "#FFFFFF" : t.text }]}>
                    {id} · {hint}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={server.geminiModel ?? ""}
            onChangeText={(geminiModel) => void save({ ...server, geminiModel })}
            placeholder="모델 id 직접 입력 (새 모델이 나오면)"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={input}
          />
          <Divider />
          <Button
            label={check.state === "checking" ? "확인 중" : "연결 확인"}
            busy={check.state === "checking"}
            onPress={() => void checkGemini()}
          />
          {check.state === "done" ? (
            <Text style={[type.small, { color: check.ok ? t.ok : t.danger, fontWeight: "600" }]}>
              {check.message}
            </Text>
          ) : null}
          <Small>3.5-transcribe 는 시각이 정확한 대신 30분까지만 받아요.</Small>
          <Small>더 긴 녹음은 3.8-flash 나 콜랩이 안전해요.</Small>
          <Small>3.1-pro 는 결제를 연결한 열쇠에서만 돌아요.</Small>
        </Card>
      ) : null}

      <Card>
        <Small>바뀐 전사본은 폰에만 저장돼요.</Small>
        {mode === "colab" ? <Small>콜랩은 탭을 닫으면 그쪽 사본도 사라져요.</Small> : null}
        {mode === "tiro" ? <Small>티로에 올린 파일은 티로 계정에 남아요.</Small> : null}
      </Card>
    </ScrollView>
  );
}
