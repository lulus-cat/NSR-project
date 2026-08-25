import { useEffect, useRef, useState } from "react";
import { Animated, Text, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider, useApp } from "../src/state/AppContext";
import { Body, Button, Card, Screen } from "../src/components/ui";
import { useTheme } from "../src/theme";

/**
 * 실행 로딩 — 아이콘과 이름이 흐릿하게 떠 있다가 또렷해지면 준비가 끝난 것이다.
 *
 * 네이티브 스플래시(정지 이미지)가 사라진 직후를 이 오버레이가 이어받는다.
 * blurRadius 는 스타일이 아니라 prop 이라 JS 드라이버로 애니메이션한다 —
 * 1초짜리 일회성이라 성능 걱정할 자리가 아니다.
 */
function LaunchOverlay({ ready }: { ready: boolean }) {
  const [gone, setGone] = useState(false);
  const blur = useRef(new Animated.Value(16)).current;
  const textOpacity = useRef(new Animated.Value(0.25)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const minTimePassed = useRef(false);
  const [, force] = useState(0);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(blur, { toValue: 0, duration: 750, useNativeDriver: false }),
      Animated.timing(textOpacity, { toValue: 1, duration: 750, useNativeDriver: false }),
    ]).start(() => {
      minTimePassed.current = true;
      force((n) => n + 1);
    });
  }, [blur, textOpacity]);

  useEffect(() => {
    if (!ready || !minTimePassed.current) return;
    Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: false }).start(() =>
      setGone(true),
    );
  });

  if (gone) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: "#131312",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        opacity: fade,
        zIndex: 100,
      }}
    >
      <Animated.Image
        source={require("../assets/splash-icon.png")}
        blurRadius={blur as unknown as number}
        style={{ width: 128, height: 128 }}
      />
      <Animated.View style={{ opacity: textOpacity }}>
        <Text style={{ color: "#EAE7E1", fontSize: 28, fontWeight: "800", letterSpacing: 6 }}>
          NSR
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

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
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <LaunchOverlay ready={false} />
      </View>
    );
  }

  if (app.locked) {
    return (
      <Screen title="잠겨 있습니다">
        <Card>
          <Body muted>
            
  이 앱에는 환자 정보가 포함된 녹음 및 전사본이 저장되어 있습니다. 본인 인증 후 실행됩니다.
</Body>
          <Button label="잠금 해제" tone="primary" onPress={() => void app.unlock()} />
        </Card>
      </Screen>
    );
  }

  return (
    <>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      {/* 주요 화면은 아래 탭으로 묶여 있다. (tabs) 는 주소에 안 나타난다. */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
      {/* 설정에서 들어가는 화면들. 탭에 둘 만큼 자주 쓰지 않는다. */}
      <Stack.Screen name="ward-dict" options={{ title: "병동 사전" }} />
      <Stack.Screen name="models" options={{ title: "전사 모델" }} />
      <Stack.Screen name="shift/[id]" options={{ title: "근무 기록" }} />
    </Stack>
    <LaunchOverlay ready />
    </>
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
