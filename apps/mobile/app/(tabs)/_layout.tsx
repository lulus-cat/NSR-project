import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type, useTheme } from "../../src/theme";

/**
 * 아래 탭.
 *
 * 왜 바꿨나
 * --------
 * 전에는 모든 화면을 홈에서 밀어 올렸다. 그래서 듀티를 보다 학습으로 가려면
 * **뒤로 → 홈 → 학습** 세 번을 눌러야 했다. 근무 중에 급하게 여는 앱에서
 * 그건 그냥 안 쓰게 되는 이유가 된다.
 *
 * 탭으로 두면 어디서든 한 번이다. 도구형 앱이 거의 예외 없이 이 모양인 이유다.
 *
 * 아이콘을 안 쓴 이유
 * -----------------
 * 아이콘 라이브러리는 폰트 파일이 통째로 들어와 앱이 커진다. 한국어 탭 이름은
 * 두 글자라 글자만으로도 충분히 빨리 읽힌다. 필요해지면 그때 넣는다.
 */
export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.text,
        headerShadowVisible: false,
        headerTitleStyle: type.heading,
        sceneStyle: { backgroundColor: t.bg },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textMuted,
        // 높이를 56 으로 못 박았더니 제스처 내비 폰에서 시스템 바가 탭을
        // 통째로 가렸다. 기기 하단 인셋만큼 높이와 패딩을 함께 늘린다.
        tabBarStyle: {
          backgroundColor: t.surface,
          borderTopColor: t.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 56 + insets.bottom,
          paddingBottom: 6 + insets.bottom,
          paddingTop: 6,
        },
        // 아이콘이 없으니 라벨이 곧 탭이다. 조금 키우고 굵게 둔다.
        tabBarLabelStyle: { fontSize: 13, fontWeight: "700" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "홈", headerShown: false }} />
      <Tabs.Screen name="duty" options={{ headerShown: false, title: "듀티" }} />
      <Tabs.Screen name="care" options={{ headerShown: false, title: "마음" }} />
      <Tabs.Screen name="study" options={{ headerShown: false, title: "학습" }} />
      <Tabs.Screen name="glossary" options={{ headerShown: false, title: "용어" }} />
      <Tabs.Screen name="settings" options={{ headerShown: false, title: "설정" }} />
    </Tabs>
  );
}
