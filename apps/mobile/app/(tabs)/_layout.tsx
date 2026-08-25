import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "../../src/theme";

/**
 * 아래 탭.
 *
 * 아이콘을 안 그리던 시절, 아이콘 자리가 빈 채로 깨진 글자(☒)가 표시됐다.
 * Ionicons 는 폰트 하나로 끝나고 expo-font 가 이미 있어 네이티브 추가가 없다.
 */
const ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  index: ["home", "home-outline"],
  duty: ["calendar", "calendar-outline"],
  care: ["heart", "heart-outline"],
  study: ["school", "school-outline"],
  glossary: ["book", "book-outline"],
  settings: ["settings", "settings-outline"],
};

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        sceneStyle: { backgroundColor: t.bg },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textMuted,
        // 높이를 못 박으면 제스처 내비 폰에서 시스템 바가 탭을 가린다.
        tabBarStyle: {
          backgroundColor: t.surface,
          borderTopColor: t.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 60 + insets.bottom,
          paddingBottom: 8 + insets.bottom,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        tabBarIcon: ({ focused, color }) => {
          const pair = ICONS[route.name] ?? ICONS.index;
          return <Ionicons name={focused ? pair[0] : pair[1]} size={22} color={color} />;
        },
      })}
    >
      <Tabs.Screen name="index" options={{ title: "홈" }} />
      <Tabs.Screen name="duty" options={{ title: "듀티" }} />
      <Tabs.Screen name="care" options={{ title: "마음" }} />
      <Tabs.Screen name="study" options={{ title: "학습" }} />
      <Tabs.Screen name="glossary" options={{ title: "용어" }} />
      <Tabs.Screen name="settings" options={{ title: "설정" }} />
    </Tabs>
  );
}
