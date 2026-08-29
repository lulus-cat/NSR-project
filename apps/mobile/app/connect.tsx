/**
 * 콜랩 원터치 연결 — nsr://connect?endpoint=… 딥링크가 여는 화면.
 *
 * 콜랩 마지막 셀의 'NSR 앱에 연결' 버튼(또는 QR → 서버 첫 화면의 버튼)이
 * 이 주소를 연다. 주소를 복사해 붙여넣던 일을 버튼 한 번으로 줄인다.
 *
 * 저장은 자동이지만 맹신하지 않는다: 받자마자 /health 로 진짜 살아 있는
 * 서버인지 확인하고 결과를 그대로 보여준다.
 */
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { CONTENT_MAX, space, type, useTheme } from "../src/theme";
import { getSetting, setSetting } from "../src/db";
import { SETTINGS_KEYS } from "../src/services/scheduler";

type Phase =
  | { step: "bad"; reason: string }
  | { step: "checking"; endpoint: string }
  | { step: "done"; endpoint: string; ok: boolean; message: string };

export default function ConnectFromColab() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ endpoint?: string }>();
  const [phase, setPhase] = useState<Phase | null>(null);

  const run = useCallback(async () => {
    const raw = typeof params.endpoint === "string" ? params.endpoint.trim() : "";
    const endpoint = raw.replace(/\/+$/, "");
    // 딥링크는 아무나 만들 수 있다 — https 콜랩 터널 꼴만 받는다.
    if (!/^https:\/\/[-a-z0-9.]+\.trycloudflare\.com\/[A-Za-z0-9_-]+$/.test(endpoint)) {
      setPhase({
        step: "bad",
        reason:
          "받은 주소가 콜랩 터널 주소 꼴이 아닙니다. 콜랩 마지막 셀의 버튼으로 다시 시도하거나, 주소를 직접 붙여넣으십시오.",
      });
      return;
    }
    // 먼저 저장 — 확인이 실패해도(잠시 끊김 등) 주소는 남아서 다시 시도할 수 있다.
    const saved = await getSetting<{
      enabled?: boolean;
      endpoint?: string;
      endpoints?: Record<string, string>;
      [k: string]: unknown;
    }>(SETTINGS_KEYS.cloudTranscription, {});
    await setSetting(SETTINGS_KEYS.cloudTranscription, {
      ...saved,
      enabled: true,
      endpoint,
      mode: "colab",
      endpoints: { ...saved.endpoints, colab: endpoint },
    });
    setPhase({ step: "checking", endpoint });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${endpoint}/health`, { signal: controller.signal });
      clearTimeout(timer);
      setPhase({
        step: "done",
        endpoint,
        ok: res.ok,
        message: res.ok
          ? "콜랩 서버와 연결됐습니다. 이제 기록 화면에서 전사를 누르면 됩니다."
          : `주소는 저장했지만 서버 응답이 이상합니다 (${res.status}). 콜랩이 아직 켜지는 중일 수 있습니다.`,
      });
    } catch {
      setPhase({
        step: "done",
        endpoint,
        ok: false,
        message:
          "주소는 저장했지만 아직 서버에 닿지 않습니다. 콜랩 마지막 셀이 켜져 있는지 확인한 뒤, 전사 설정에서 '연결 확인'을 눌러 보십시오.",
      });
    }
  }, [params.endpoint]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.lg + insets.bottom,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
    >
      <Card tone={phase?.step === "bad" ? "warn" : "accent"}>
        <Heading>콜랩 연결</Heading>
        {phase === null || phase.step === "checking" ? (
          <>
            <Badge text="확인 중" tone="muted" />
            <Body muted>콜랩에서 받은 주소를 저장하고 서버 상태를 확인하고 있습니다.</Body>
          </>
        ) : phase.step === "bad" ? (
          <Body muted>{phase.reason}</Body>
        ) : (
          <>
            <Badge text={phase.ok ? "연결됨" : "저장됨 · 확인 필요"} tone={phase.ok ? "ok" : "warn"} />
            <Body muted>{phase.message}</Body>
            <Divider />
            <Text style={[type.small, { color: t.textMuted, fontWeight: "600" }]} selectable>
              {phase.endpoint}
            </Text>
          </>
        )}
        <Button label="홈으로" tone="primary" onPress={() => router.replace("/(tabs)")} />
        <Button label="전사 설정 열기" onPress={() => router.replace("/models")} />
        <Small>
          콜랩 세션이 새로 켜지면 주소가 바뀝니다 — 그때도 콜랩의 연결 버튼(또는 QR) 한
          번이면 됩니다.
        </Small>
      </Card>
    </ScrollView>
  );
}
