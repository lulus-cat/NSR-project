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
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { TABULAR, TOUCH_MIN, radius, space, type, useTheme } from "../theme";

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
    <View style={{ padding: space.lg, gap: space.md, paddingBottom: space.bottom }}>
      {title ? (
        <View style={{ gap: space.tight, marginBottom: space.sm }}>
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
        borderRadius: radius.lg,
        minHeight: TOUCH_MIN,
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "center",
        gap: space.sm,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={[type.button, { color: fg }]}>{label}</Text>
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
        minHeight: TOUCH_MIN,
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
      <Text style={[type.caption, { color }]}>{text}</Text>
    </View>
  );
}

/**
 * 색면 헤더 + 그 위로 겹쳐 올라오는 콘텐츠 패널.
 *
 * 왜 겹치는가
 * ----------
 * 헤더와 본문을 위아래로 나란히 두면 그냥 덩어리 두 개로 보인다.
 * 패널이 색면을 **물고 올라와야** 한 화면으로 읽힌다. 이 겹침 하나가
 * "만들다 만 느낌"과 "완성된 느낌"을 가른다.
 *
 * 헤더에는 그 화면의 **대표 숫자 하나**만 크게 얹는다. 두 개를 나란히 두면
 * 둘 다 안 읽힌다. 나머지는 아래 label/value 행으로 내린다.
 */
export function HeaderScreen({
  title,
  right,
  heroLabel,
  hero,
  rows,
  children,
  refreshControl,
}: {
  title: string;
  right?: ReactNode;
  heroLabel?: string;
  hero?: string;
  /** 색면 안 label/value 행. 값에 색을 주려면 tone 을 넘긴다. */
  rows?: { label: string; value: string; tone?: "default" | "alert" }[];
  children: ReactNode;
  refreshControl?: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: t.headerBg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ backgroundColor: t.bg }}
        refreshControl={refreshControl as never}
      >
        {/* 색면. 상태바 아래까지 꽉 채운다. */}
        <View
          style={{
            backgroundColor: t.headerBg,
            paddingTop: insets.top + space.md,
            paddingHorizontal: space.lg,
            // 패널이 위로 24 올라오므로 그만큼 더 준다.
            paddingBottom: space.xxl + 24,
            gap: space.md,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: TOUCH_MIN,
            }}
          >
            <Text style={[type.title, { color: t.headerText }]}>{title}</Text>
            {right}
          </View>

          {hero ? (
            <View style={{ gap: space.xxs }}>
              {heroLabel ? (
                <Text style={[type.small, { color: t.headerTextMuted }]}>{heroLabel}</Text>
              ) : null}
              <Text style={[type.hero, TABULAR, { color: t.headerText }]}>{hero}</Text>
            </View>
          ) : null}

          {rows && rows.length > 0 ? (
            <View style={{ gap: space.sm }}>
              {rows.map((r) => (
                <View
                  key={r.label}
                  style={{ flexDirection: "row", justifyContent: "space-between" }}
                >
                  <Text style={[type.small, { color: t.headerTextMuted }]}>{r.label}</Text>
                  <Text
                    style={[
                      type.cardTitle,
                      TABULAR,
                      { color: r.tone === "alert" ? t.warn : t.headerText },
                    ]}
                  >
                    {r.value}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        {/* 패널. 음수 마진으로 색면을 물고 올라온다. */}
        <View
          style={{
            backgroundColor: t.bg,
            marginTop: -24,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingHorizontal: space.lg,
            paddingTop: space.xxl,
            paddingBottom: space.bottom,
            gap: space.md,
            minHeight: 400,
          }}
        >
          {children}
        </View>
      </ScrollView>
    </View>
  );
}

/** 목록 위에 얹는 필터 칩 한 줄. */
export function ChipRow({
  items,
  active,
  onSelect,
}: {
  items: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  const t = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: space.sm, paddingRight: space.lg }}
    >
      {items.map((it) => {
        const on = it.key === active;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(it.key)}
            style={{
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
              borderRadius: radius.full,
              backgroundColor: on ? t.accent : t.surface,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: on ? t.accent : t.border,
            }}
          >
            <Text
              style={[
                type.small,
                { color: on ? "#FFFFFF" : t.text, fontWeight: "700" },
              ]}
            >
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** 목록을 묶는 작은 날짜/구간 머리. */
export function GroupHeader({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text style={[type.small, { color: t.textMuted, marginTop: space.sm }]}>{children}</Text>
  );
}
