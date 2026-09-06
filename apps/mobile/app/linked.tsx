/**
 * 기기 잇기 — `nsr://linked?c=…` 딥링크가 여는 화면.
 *
 * 구글 로그인을 마치면 서버가 이 주소로 앱을 다시 연다. c 는 **일회용 쪽지**이고,
 * 이 화면은 그것을 이 폰의 열쇠로 바꿔 보안 저장소에 넣는다. 사람이 옮겨 적는
 * 것은 이제 없다.
 *
 * 쪽지는 5분 뒤 사라지고 한 번 쓰면 없어진다. 그래서 실패하면 되돌릴 방법은
 * 하나뿐이다 — 설정에서 다시 로그인. 화면도 그렇게만 안내한다.
 */
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Button, Card, Heading, Small } from "../src/components/ui";
import { CONTENT_MAX, space, type, useTheme } from "../src/theme";
import { claimDeviceToken } from "../src/services/nsr-server";

type Phase =
  | { step: "working" }
  | { step: "done" }
  | { step: "bad"; reason: string };

export default function Linked() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ c?: string }>();
  const [phase, setPhase] = useState<Phase>({ step: "working" });

  const run = useCallback(async () => {
    const code = (params.c ?? "").trim();
    if (!code) {
      setPhase({ step: "bad", reason: "연결 정보가 없어요. 설정에서 다시 로그인해 주세요." });
      return;
    }
    setPhase({ step: "working" });
    try {
      await claimDeviceToken(code);
      setPhase({ step: "done" });
    } catch (e) {
      setPhase({
        step: "bad",
        reason: e instanceof Error ? e.message : "연결하지 못했어요. 다시 로그인해 주세요.",
      });
    }
  }, [params.c]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: insets.bottom + space.bottom,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
    >
      <Card>
        <Heading>분석 서버에 잇는 중이에요</Heading>
        {phase.step === "working" ? <Small>잠깐만요. 열쇠를 받고 있어요.</Small> : null}
        {phase.step === "done" ? (
          <>
            <Badge text="연결됐어요" tone="ok" />
            <Small>이제 근무를 보내고 결과를 받을 수 있어요.</Small>
            <Small>열쇠는 이 폰 안에만 있어요. 적어 둘 필요 없어요.</Small>
            <Button label="설정으로" tone="primary" onPress={() => router.replace("/settings")} />
          </>
        ) : null}
        {phase.step === "bad" ? (
          <>
            <Text style={[type.small, { color: t.danger }]}>{phase.reason}</Text>
            <Button label="설정으로" tone="primary" onPress={() => router.replace("/settings")} />
          </>
        ) : null}
      </Card>
    </ScrollView>
  );
}
