import { useEffect, useRef, useState } from "react";
import { Animated, Text, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider, useApp } from "../src/state/AppContext";
import { Button } from "../src/components/ui";
import { useTheme } from "../src/theme";

/**
 * 실행 로딩 — 흐릿한 마크가 또렷해지는 페이드인.
 *
 * blurRadius 를 직접 애니메이션하면 매 프레임 JS→네이티브 다리를 건너 뚝뚝
 * 끊긴다. 대신 **또렷한 이미지 위에 흐린 사본을 겹쳐 두고, 흐린 쪽의
 * 불투명도만** 네이티브 드라이버로 내린다 — 시각적으로 같고 60fps 다.
 */
function LaunchOverlay({ ready }: { ready: boolean }) {
  const [gone, setGone] = useState(false);
  const blurOpacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1.06)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const [minDone, setMinDone] = useState(false);

  useEffect(() => {
    // 1.2초 — 로딩 가림막이 아니라 인사다. 너무 짧으면 흐림→명료가 안 읽힌다.
    Animated.parallel([
      Animated.timing(blurOpacity, { toValue: 0, duration: 1200, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 1200, useNativeDriver: true }),
      Animated.timing(textOpacity, { toValue: 1, duration: 1100, delay: 250, useNativeDriver: true }),
    ]).start(() => setMinDone(true));
  }, [blurOpacity, scale, textOpacity]);

  useEffect(() => {
    if (!ready || !minDone) return;
    Animated.timing(fade, { toValue: 0, duration: 280, useNativeDriver: true }).start(() =>
      setGone(true),
    );
  }, [ready, minDone, fade]);

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
      <Animated.View style={{ width: 128, height: 128, transform: [{ scale }] }}>
        <Animated.Image
          source={require("../assets/splash-icon.png")}
          style={{ position: "absolute", width: 128, height: 128 }}
        />
        <Animated.Image
          source={require("../assets/splash-icon.png")}
          blurRadius={18}
          style={{ position: "absolute", width: 128, height: 128, opacity: blurOpacity }}
        />
      </Animated.View>
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
    // 잠금화면은 실행 로딩과 같은 얼굴이다 — 가운데 로고, 아래 단추 하나.
    // "잠겨 있습니다" 같은 상태 설명 문장은 두지 않는다.
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: "#131312",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <Animated.Image
          source={require("../assets/splash-icon.png")}
          style={{ width: 128, height: 128 }}
        />
        <Text style={{ color: "#EAE7E1", fontSize: 28, fontWeight: "800", letterSpacing: 6 }}>
          NSR
        </Text>
        <View style={{ width: 200, marginTop: 24 }}>
          <Button label="잠금 해제" tone="primary" onPress={() => void app.unlock()} />
        </View>
      </View>
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
