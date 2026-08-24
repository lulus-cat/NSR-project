import { useEffect } from "react";
import { View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider, useApp } from "../src/state/AppContext";
import { Body, Button, Card, Screen } from "../src/components/ui";
import { useTheme } from "../src/theme";

function Gate() {
  const t = useTheme();
  const app = useApp();
  const router = useRouter();
  const segments = useSegments();

  // 최초 고지를 마치기 전에는 다른 화면으로 못 간다.
  useEffect(() => {
    if (!app.ready) return;
    const onOnboarding = segments[0] === "onboarding";
    if (!app.onboarded && !onOnboarding) router.replace("/onboarding");
    if (app.onboarded && onOnboarding) router.replace("/");
  }, [app.ready, app.onboarded, segments, router]);

  if (!app.ready) {
    return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  }

  if (app.locked) {
    return (
      <Screen title="잠겨 있습니다">
        <Card>
          <Body muted>
            이 앱에는 근무 중 녹음과 환자 정보가 포함될 수 있는 전사본이 들어 있습니다.
            본인 확인 후 열립니다.
          </Body>
          <Button label="잠금 해제" tone="primary" onPress={() => void app.unlock()} />
        </Card>
      </Screen>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="duty" options={{ title: "듀티표" }} />
      <Stack.Screen name="study" options={{ title: "학습" }} />
      <Stack.Screen name="glossary" options={{ title: "용어와 자료" }} />
      <Stack.Screen name="ward-dict" options={{ title: "병동 사전" }} />
      <Stack.Screen name="settings" options={{ title: "설정" }} />
      <Stack.Screen name="shift/[id]" options={{ title: "근무 기록" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="auto" />
        <Gate />
      </AppProvider>
    </SafeAreaProvider>
  );
}
