import { useColorScheme } from "react-native";

/**
 * 색·간격·글자.
 *
 * 야간 근무 중 어두운 스테이션에서 보는 화면이다. 다크 모드가 기본에 가깝고,
 * 대비를 충분히 준다. 태움 지표는 빨강 하나로 몰지 않는다 —
 * 화면을 열자마자 빨간 숫자가 보이는 건 도움이 안 된다.
 *
 * 수치 근거
 * --------
 * 감으로 정하지 않고 공개된 디자인 시스템의 토큰 파일에서 가져왔다.
 *   - 당근 SEED (daangn/seed-design) — 한국어 앱의 실제 치수
 *   - Material 3 (callstack/react-native-paper 의 토큰 구현)
 *   - KRDS (범정부 디자인시스템) — 한글 접근성 기준
 */
export interface Theme {
  bg: string;
  /** 콘텐츠가 올라가는 면. 배경보다 반드시 밝다(다크 기준). */
  surface: string;
  /** 눌림·입력칸처럼 한 단계 더 뜬 면. */
  surfaceAlt: string;
  /** 바텀시트·모달처럼 떠 있는 면. 다크에서 계층은 그림자가 아니라 밝기로 만든다. */
  surfaceRaised: string;
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
  bg: "#F4F4F2",
  surface: "#FFFFFF",
  surfaceAlt: "#EFEEEB",
  surfaceRaised: "#FFFFFF",
  border: "#E0DED9",
  text: "#1A1917",
  textMuted: "#6B6862",
  accent: "#2F6F5E",
  accentSoft: "#E3EFEA",
  danger: "#B3402F",
  warn: "#8A5F10",
  ok: "#2F6F5E",
  recording: "#C0553F",
};

/**
 * 다크에서 지킨 두 가지.
 *
 *  1. **순검정과 순백을 같이 쓰지 않는다.** 배경을 #000 으로 두면 그 위에 올릴
 *     밝기 단계가 사라진다. M3 는 배경 #141218 / 본문 #E6E0E9, SEED 는
 *     표면 #16171b / 본문 #f3f4f5 를 쓴다. 어느 쪽도 극단값 조합이 아니다.
 *  2. **계층은 그림자가 아니라 표면 밝기로 만든다.** 다크에서 그림자는 거의
 *     안 보인다 — SEED 는 그래서 다크 그림자 불투명도를 8% → 50% 까지 올려서
 *     겨우 쓴다. 배경 < 표면 < 떠 있는 면 순서로 밝아지게 두는 편이 낫다.
 */
const dark: Theme = {
  bg: "#131312",
  surface: "#1C1C1A",
  surfaceAlt: "#262624",
  surfaceRaised: "#2B2B28",
  border: "#383733",
  text: "#EAE7E1",
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

/**
 * 간격. 4의 배수가 기본이되 6px 하프스텝을 둔다 —
 * 제목과 부제 사이는 8이면 뜨고 4면 붙는다 (SEED `between-text` = 6px).
 */
export const space = {
  xxs: 2,
  xs: 4,
  /** 제목↔부제처럼 딱 붙는 한 쌍. */
  tight: 6,
  sm: 8,
  md: 12,
  /** 화면 좌우 여백. 전 화면 예외 없이 이 값. */
  lg: 16,
  xl: 20,
  xxl: 24,
  section: 32,
  /** 스크롤 맨 아래 여백. 마지막 항목이 화면 끝에 붙지 않게. */
  bottom: 56,
} as const;

/** 카드 12 는 M3 Card 기본값(corner.medium)이자 SEED 의 기본 반경이다. */
export const radius = { sm: 6, md: 8, lg: 12, xl: 16, full: 9999 } as const;

/** 손가락이 닿아야 하는 최소 크기. 안드로이드 접근성 기준 48dp. */
export const TOUCH_MIN = 48;

/**
 * 글자.
 *
 * `lineHeight` 는 배수가 아니라 **절대 px** 이다. 웹 감각으로 1.4 를 넣으면
 * 1.4px 가 되어 줄이 겹친다. 그래서 전부 계산해서 정수로 박아 둔다.
 *
 * 한글에서 줄 간격 규칙은 "무조건 크게"가 아니다.
 *   한 줄로 끝나는 UI 라벨 → 1.35 안팎으로 조인다
 *   여러 줄 읽는 본문     → 1.5 로 푼다
 * 같은 16px 인데 카드 제목은 22, 본문은 24 를 쓰는 이유다 (SEED 도 동일).
 *
 * **자간은 전부 0.** "한글은 자간을 좁혀야 한다"는 말에 근거가 없다 —
 * SEED 는 자간 토큰이 아예 없고, KRDS 는 0 과 +1px 둘뿐, M3 는 0~+0.5 다.
 * 음수 자간은 받침 있는 글자(밝·없·궤)에서 획을 붙여 오히려 읽기 나쁘게 만든다.
 */
export const type = {
  /** 화면 제목. */
  title: { fontSize: 24, lineHeight: 32, fontWeight: "700" as const },
  /** 섹션 제목. */
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "700" as const },
  /** 카드·목록 제목. 한 줄로 끝나는 자리. */
  cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: "500" as const },
  /** 본문. 여러 줄 읽는 자리라 줄 간격을 푼다. */
  body: { fontSize: 16, lineHeight: 24 },
  /** 메타·부제. */
  small: { fontSize: 13, lineHeight: 18 },
  /**
   * 캡션·배지. 16px 미만은 굵게 쓴다 —
   * 작은 글씨를 regular + 회색으로 두면 다크에서 거의 안 보인다 (SEED 접근성 규칙).
   */
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "600" as const },
  /** 버튼 라벨. */
  button: { fontSize: 15, lineHeight: 20, fontWeight: "700" as const },
  /** 숫자. 자리가 흔들리지 않게 고정폭 숫자를 쓴다. */
  mono: { fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums" as const] },
} as const;
