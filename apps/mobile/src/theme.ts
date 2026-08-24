import { useColorScheme } from "react-native";

/**
 * 색과 간격.
 *
 * 야간 근무 중에 어두운 스테이션에서 보는 화면이다. 다크 모드가 기본에 가깝고,
 * 대비를 충분히 준다. 태움 지표는 빨강 하나로 몰지 않는다 —
 * 화면을 열자마자 빨간 숫자가 보이는 건 도움이 안 된다.
 */
export interface Theme {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  danger: string;
  warn: string;
  ok: string;
  recording: string;
}

const light: Theme = {
  bg: "#F7F7F5",
  surface: "#FFFFFF",
  surfaceAlt: "#F0EFEC",
  border: "#E2E0DB",
  text: "#1A1917",
  textMuted: "#6B6862",
  accent: "#2F6F5E",
  accentSoft: "#E3EFEA",
  danger: "#B3402F",
  warn: "#9A6B12",
  ok: "#2F6F5E",
  recording: "#C0553F",
};

const dark: Theme = {
  bg: "#131312",
  surface: "#1C1C1A",
  surfaceAlt: "#242422",
  border: "#33322F",
  text: "#F0EEE9",
  textMuted: "#9A968E",
  accent: "#6FBFA4",
  accentSoft: "#1E332C",
  danger: "#E08268",
  warn: "#D9A94C",
  ok: "#6FBFA4",
  recording: "#E08268",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = { sm: 6, md: 10, lg: 16 } as const;

export const type = {
  title: { fontSize: 26, fontWeight: "700" as const, letterSpacing: -0.4 },
  heading: { fontSize: 18, fontWeight: "600" as const },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 19 },
  mono: { fontSize: 13, fontVariant: ["tabular-nums" as const] },
} as const;
