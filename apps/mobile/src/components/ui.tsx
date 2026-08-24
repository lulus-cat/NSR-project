import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { radius, space, type, useTheme } from "../theme";

export function Screen({
  title,
  subtitle,
  children,
  scroll = true,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
}) {
  const t = useTheme();
  const body = (
    <View style={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}>
      {title ? (
        <View style={{ gap: space.xs, marginBottom: space.sm }}>
          <Text style={[type.title, { color: t.text }]}>{title}</Text>
          {subtitle ? (
            <Text style={[type.small, { color: t.textMuted }]}>{subtitle}</Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      {scroll ? <ScrollView>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  tone = "default",
}: {
  children: ReactNode;
  style?: ViewStyle;
  tone?: "default" | "accent" | "warn";
}) {
  const t = useTheme();
  const bg =
    tone === "accent" ? t.accentSoft : tone === "warn" ? t.surfaceAlt : t.surface;
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.border,
          padding: space.lg,
          gap: space.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[type.heading, { color: t.text }]}>{children}</Text>;
}

export function Body({
  children,
  muted,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  const t = useTheme();
  return (
    <Text style={[type.body, { color: muted ? t.textMuted : t.text }]}>{children}</Text>
  );
}

export function Small({
  children,
  muted = true,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  const t = useTheme();
  return (
    <Text style={[type.small, { color: muted ? t.textMuted : t.text }]}>{children}</Text>
  );
}

export function Button({
  label,
  onPress,
  tone = "default",
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
  busy?: boolean;
}) {
  const t = useTheme();
  const bg = tone === "primary" ? t.accent : tone === "danger" ? t.danger : t.surfaceAlt;
  const fg = tone === "default" ? t.text : "#FFFFFF";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => ({
        backgroundColor: bg,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        borderRadius: radius.md,
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "center",
        gap: space.sm,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: "600", fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function Row({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  const t = useTheme();
  const content = (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: space.md,
        gap: space.md,
      }}
    >
      <Text style={[type.body, { color: t.text, flexShrink: 1 }]}>{label}</Text>
      {value ? (
        <Text style={[type.small, { color: t.textMuted, textAlign: "right" }]}>
          {value}
        </Text>
      ) : null}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }} />;
}

export function Badge({ text, tone }: { text: string; tone: "ok" | "warn" | "danger" | "muted" }) {
  const t = useTheme();
  const color =
    tone === "ok" ? t.ok : tone === "warn" ? t.warn : tone === "danger" ? t.danger : t.textMuted;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: color,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}
