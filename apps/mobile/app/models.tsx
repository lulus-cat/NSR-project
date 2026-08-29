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
import { SETTINGS_KEYS } from "../src/services/scheduler";

type ServerMode = "colab" | "pc" | "gemini";

interface ServerAsr {
  enabled: boolean;
  /** 지금 쓰는 주소. 전사(resolveProvider)는 이 값만 본다. */
  endpoint: string;
  model?: string;
  mode?: ServerMode;
  /** 모드별로 기억해 두는 주소 — 모드를 오가도 붙여넣은 주소가 안 날아간다. */
  endpoints?: Partial<Record<ServerMode, string>>;
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
  if (server.endpoint && !server.endpoint.includes("trycloudflare.com")) return "pc";
  return "colab";
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
        flex: 1,
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
      <Text style={[type.heading, { color: t.text }]}>{title}</Text>
      <Text style={[type.small, { color: t.textMuted, fontWeight: "600" }]}>{caption}</Text>
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
  const [server, setServer] = useState<ServerAsr>({ enabled: false, endpoint: "" });
  const [check, setCheck] = useState<
    { state: "idle" } | { state: "checking" } | { state: "done"; ok: boolean; message: string }
  >({ state: "idle" });
  // Gemini 키 — 보조 기능과 같은 보안 저장소 항목을 쓴다(구글 AI 키는 하나).
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
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
    })();
  }, []);

  const save = useCallback(async (next: ServerAsr) => {
    // 켜고 끄는 스위치는 없다 — 전사 경로가 서버뿐이라 주소가 있으면 켜진 것이다.
    const stored = { ...next, enabled: next.endpoint.trim().length > 0 };
    setServer(stored);
    await setSetting(SETTINGS_KEYS.cloudTranscription, stored);
  }, []);


  const mode = inferMode(server);
  const models = mode === "gemini" ? [] : serverModelsFor(mode);
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
      const keepModel =
        nextMode !== "gemini" &&
        server.model &&
        serverModelsFor(nextMode).some((m) => m.id === server.model)
          ? server.model
          : undefined;
      void save({
        ...server,
        endpoint: server.endpoints?.[nextMode] ?? "",
        model: keepModel,
        mode: nextMode,
      });
    },
    [mode, save, server],
  );

  const saveGeminiKey = useCallback(async () => {
    const key = geminiKeyInput.trim();
    await setApiKey(key || null, "gemini");
    setHasGeminiKey(key.length > 0);
    setGeminiKeyInput("");
    setCheck({
      state: "done",
      ok: key.length > 0,
      message: key ? "키를 기기 보안 저장소에 넣었습니다." : "키를 지웠습니다.",
    });
  }, [geminiKeyInput]);

  const checkGemini = useCallback(async () => {
    const key = await getApiKey("gemini");
    if (!key) {
      setCheck({ state: "done", ok: false, message: "키를 먼저 저장하십시오." });
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
          ? { state: "done", ok: true, message: "연결됐습니다. 이제 기록 화면에서 전사를 누르면 됩니다." }
          : { state: "done", ok: false, message: `키가 거부됐습니다 (${res.status}). 키를 다시 확인하십시오.` },
      );
    } catch {
      setCheck({ state: "done", ok: false, message: "구글에 연결하지 못했습니다. 네트워크를 확인하십시오." });
    }
  }, []);

  const checkConnection = useCallback(async () => {
    const base = server.endpoint.trim().replace(/\/+$/, "");
    if (!base) {
      setCheck({ state: "done", ok: false, message: "주소를 먼저 넣으십시오." });
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
          ? { state: "done", ok: true, message: "연결됐습니다. 이제 기록 화면에서 전사를 누르면 됩니다." }
          : {
              state: "done",
              ok: false,
              message: `서버가 ${res.status}로 답했습니다. 주소를 끝까지(비밀 문자열 포함) 붙여넣었는지 확인하십시오.`,
            },
      );
    } catch {
      setCheck({
        state: "done",
        ok: false,
        message:
          mode === "colab"
            ? "연결하지 못했습니다. 콜랩 노트가 '모두 실행' 상태인지, 주소를 통째로 붙여넣었는지 확인하십시오."
            : "연결하지 못했습니다. 폰과 컴퓨터가 같은 Wi-Fi인지, 서버가 켜져 있는지 확인하십시오.",
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
        <Heading>어디서 전사합니까</Heading>
        <Small>
          전사는 폰이 아니라 아래 셋 중 한 곳이 합니다. 콜랩·내 컴퓨터는 휘스퍼
          모델을 돌리는 서버 방식이고, Gemini 는 서버 없이 구글 AI 에 직접 보내는
          다른 방식입니다. 기록 음성이 선택한 곳으로 전송됩니다.
        </Small>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <ModeTile
            icon="logo-google"
            title="콜랩"
            caption="GPU 노트 · 휘스퍼"
            selected={mode === "colab"}
            onPress={() => switchMode("colab")}
          />
          <ModeTile
            icon="laptop-outline"
            title="내 컴퓨터"
            caption="같은 Wi-Fi · 휘스퍼"
            selected={mode === "pc"}
            onPress={() => switchMode("pc")}
          />
          <ModeTile
            icon="sparkles-outline"
            title="Gemini"
            caption="API 키 하나 · 서버 없이"
            selected={mode === "gemini"}
            onPress={() => switchMode("gemini")}
          />
        </View>
      </Card>

      {/* ── 선택한 방식의 연결 ── */}
      {mode === "colab" ? (
        <Card tone="accent">
          <Heading>콜랩 연결</Heading>
          <Small>
            기록 음성이 구글(콜랩) 서버와 Cloudflare 터널을 지나갑니다 — 내 컴퓨터가
            아닙니다. 전사하는 동안 콜랩 탭을 열어 두십시오. 탭을 닫으면 서버도 꺼집니다.
          </Small>
          <Divider />
          <Small muted={false}>1. 콜랩 노트를 열고 &lsquo;런타임 → 모두 실행&rsquo;</Small>
          <Button label="콜랩 노트 열기" tone="primary" onPress={() => void Linking.openURL(COLAB_NOTEBOOK_URL)} />
          <Small muted={false}>2. 마지막 셀에 나온 주소를 통째로 붙여넣기</Small>
          <TextInput
            value={server.endpoint}
            onChangeText={setEndpoint}
            placeholder="https://….trycloudflare.com/비밀문자열"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={input}
          />
          <Small>
            콜랩 세션이 꺼졌다 켜지면 주소가 새로 나옵니다 — 그때마다 다시 붙여넣으십시오.
          </Small>
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
          <Heading>내 컴퓨터 연결</Heading>
          <Small>
            같은 Wi-Fi의 내 컴퓨터가 전사합니다. 음성이 그 컴퓨터로만 가므로,{" "}
            <Text style={{ fontWeight: "700" }}>내 컴퓨터에만</Text> 연결하십시오.
          </Small>
          <Divider />
          <Small muted={false}>1. 컴퓨터에서 한 번만: Docker(docker.com) 설치 후 터미널에 입력</Small>
          <View style={{ backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
            <Text selectable style={{ color: t.text, fontFamily: "monospace", fontSize: 12 }}>
              docker run -d -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
            </Text>
          </View>
          <Small muted={false}>2. 컴퓨터의 Wi-Fi IP를 확인해 주소로 넣기</Small>
          <TextInput
            value={server.endpoint}
            onChangeText={setEndpoint}
            placeholder="http://192.168.0.10:8000"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={input}
          />
          <Small>
            OpenAI 호환(/v1/audio/transcriptions) 서버라면 무엇이든 붙습니다. 집 밖에서도
            쓰려면 Tailscale 이 가장 쉽습니다.
          </Small>
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
      {mode === "gemini" ? (
        <Card tone="accent">
          <Heading>Gemini 직접 전사</Heading>
          <Small>
            콜랩도 서버도 없습니다 — 구글 AI 키 하나면 폰이 기록을 Gemini 로 보내
            전사와 화자 라벨까지 받아 옵니다. 일반 모델(3.7-flash 등)의{" "}
            <Text style={{ fontWeight: "700" }}>시각은 추정치</Text>라 문장 탭 재생이 몇 초
            어긋날 수 있고, 전문 전사 모델(3.5-transcribe)은 단어 단위 실측이라
            정확합니다.
          </Small>
          <Divider />
          <Small muted={false}>알고 쓰십시오</Small>
          <Small>
            기록 음성이 구글 Gemini 서버로 전송됩니다.{" "}
            <Text style={{ fontWeight: "700" }}>
              무료 티어는 입력이 구글의 모델 개선에 쓰일 수 있습니다
            </Text>{" "}
            — 병동 음성이라면 결제를 연결한(유료) 키를 권합니다. 올린 파일은 전사
            직후 앱이 지웁니다.
          </Small>
          <Divider />
          <Small muted={false}>
            1. API 키{hasGeminiKey ? " — 저장돼 있습니다" : ""}
          </Small>
          <Button
            label="키 발급 열기 (aistudio.google.com)"
            onPress={() => void Linking.openURL("https://aistudio.google.com/apikey")}
          />
          <TextInput
            value={geminiKeyInput}
            onChangeText={setGeminiKeyInput}
            placeholder="AIza… 키 붙여넣기"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={input}
          />
          <Button
            label={hasGeminiKey && geminiKeyInput.trim().length === 0 ? "키 지우기" : "키 저장"}
            tone={hasGeminiKey && geminiKeyInput.trim().length === 0 ? "default" : "primary"}
            onPress={() => void saveGeminiKey()}
          />
          <Small>
            키는 기기 보안 저장소에만 보관되고, 설정 → 보조 기능의 Gemini 와 같은
            키를 씁니다.
          </Small>
          <Divider />
          <Small muted={false}>2. 모델</Small>
          <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
            {[
              ["gemini-3.7-flash", "기본 — 긴 기록도 통짜로"],
              ["gemini-3.5-transcribe", "전문 전사 — 30분 이하"],
              ["gemini-3.1-pro-preview", "가장 정확 — 유료 키 전용"],
            ].map(([id, hint]) => {
              const on = (server.geminiModel?.trim() || "gemini-3.7-flash") === id;
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
          <Small>
            모델마다 성격이 다릅니다. <Text style={{ fontWeight: "700" }}>3.5-transcribe</Text> 는
            받아쓰기 전용 모델이라 화자와 단어 시각이 실측으로 정확하지만, 화자 분리를 켠
            요청은 30분 한도가 있습니다 — 30분 분할 기록과 짝입니다. 긴 통짜 기록은
            3.7-flash(시각은 추정치)나 콜랩이 안전하고, 3.1-pro 는 무료 티어가 없어 결제
            연결 키에서만 돕니다.
          </Small>
        </Card>
      ) : null}

      {/* ── 화자 분리 — 콜랩 전용. 준비는 앱이 아니라 콜랩 쪽에서 한 번만 ── */}
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
            <Text style={[type.body, { color: t.text, fontWeight: "600" }]}>화자 분리 사용</Text>
            <Switch
              value={!!server.diarize}
              onValueChange={(v) => void save({ ...server, diarize: v })}
            />
          </View>
          <Small>
            전사와 함께 누가 말했는지(화자 1·2·3…)를 자동으로 나눕니다 — 문장 중간에
            화자가 바뀌어도 단어 단위로 경계를 맞춥니다. 기록 화면에서 화자별 역할을
            한 번에 지정할 수 있고, 전사가 몇 분 더 걸립니다.
          </Small>
          <Divider />
          <Small muted={false}>준비는 콜랩 쪽에서 한 번만 (무료 · 약 5분)</Small>
          <Small>
            앱에는 넣을 것이 없습니다. 허깅페이스 토큰을{" "}
            <Text style={{ fontWeight: "700" }}>콜랩 왼쪽 열쇠 아이콘(보안 비밀)</Text>에
            &lsquo;HF_TOKEN&rsquo;으로 한 번 저장해 두면 노트가 세션마다 알아서
            읽습니다. 아래 순서대로 — 노트를 실행하면 같은 안내가 출력됩니다.
          </Small>
          <Button
            label="1. 분리 모델 동의 (huggingface)"
            onPress={() =>
              void Linking.openURL("https://huggingface.co/pyannote/speaker-diarization-3.1")
            }
          />
          <Button
            label="2. 구간 모델 동의 (huggingface)"
            onPress={() =>
              void Linking.openURL("https://huggingface.co/pyannote/segmentation-3.0")
            }
          />
          <Button
            label="3. 토큰 발급 (Read) → 콜랩 보안 비밀에 저장"
            onPress={() => void Linking.openURL("https://huggingface.co/settings/tokens")}
          />
          <Small>
            준비가 안 된 채 켜면 그 전사는 화자 없이 전사만 돌아옵니다 — 실패하지
            않습니다.
          </Small>
        </Card>
      ) : null}

      {/* ── 모델 선택(휘스퍼 경로): 콜랩·PC 는 같은 문법, Gemini 는 자기 카드에서 ── */}
      {mode !== "gemini" ? (
      <Card>
        <Heading>전사 모델</Heading>
        <Small>
          {mode === "colab"
            ? "누르면 다음 전사부터 그 모델을 씁니다. 콜랩이 처음 쓰는 모델은 내려받느라 몇 분 더 걸립니다 — 폰에는 아무것도 받지 않습니다."
            : "누르면 다음 전사부터 그 모델을 씁니다. 컴퓨터가 첫 전사 때 알아서 내려받습니다 — 폰에는 아무것도 받지 않습니다."}
        </Small>
        <Divider />
        {models.map((m, i) => (
          <View key={m.id}>
            {i > 0 ? <Divider /> : null}
            <ModelRow
              model={m}
              selected={selectedModelId === m.id}
              onSelect={() => void save({ ...server, model: m.id })}
            />
          </View>
        ))}
        {mode === "pc" ? (
          <>
            <Divider />
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: selectedModelId === undefined }}
              onPress={() => void save({ ...server, model: undefined })}
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
                <Text style={[type.body, { color: t.text, fontWeight: "700" }]}>서버 기본값</Text>
                {selectedModelId === undefined ? (
                  <Badge text="선택됨" tone="ok" />
                ) : (
                  <Text style={[type.small, { color: t.textMuted, fontWeight: "600" }]}>선택</Text>
                )}
              </View>
              <Small>모델을 지정하지 않고 서버가 미리 실어 둔 모델을 그대로 씁니다.</Small>
            </Pressable>
          </>
        ) : null}
      </Card>

      ) : null}

      <Card>
        <Small>
          전사가 끝난 전사본은 폰에만 저장됩니다. 콜랩은 세션을 닫으면 서버 쪽 사본도 함께
          사라집니다.
        </Small>
      </Card>
    </ScrollView>
  );
}
