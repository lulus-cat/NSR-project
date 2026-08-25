import { useEffect, useRef } from "react";
import { Animated, Image, View } from "react-native";

/** 표시 눈금 범위. 35.5°가 바닥, 42°가 꼭대기 — 그 위는 가득 찬 채로 라벨이 말한다. */
export const SCALE_MIN = 35.5;
export const SCALE_MAX = 42;

/**
 * 수은 체온계 — 유리관·눈금·광택·그림자는 미리 그린 PNG 오버레이이고,
 * 앱은 그 아래에서 수은 기둥과 전구만 그려 색·높이를 움직인다.
 *
 * 좌표 계약 (생성기: scratchpad/gen-thermo.mjs 와 짝):
 *   기둥 left 40, width 20, bottom 45, height 16→145 (f=0→1)
 *   전구 중심 (50, 180), 지름 44
 *   눈금은 같은 식 h(f) = 16 + 129f 로 이미지에 박혀 있어 수은 꼭대기와 정확히 만난다.
 */
export function Thermometer({ celsius, color }: { celsius: number | null; color: string }) {
  const f =
    celsius === null
      ? 0
      : Math.min(1, Math.max(0, (celsius - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)));
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(v, {
      toValue: f,
      friction: 10,
      tension: 26,
      // height 애니메이션이라 JS 드라이버. 화면당 한 번 차오르는 것이 전부다.
      useNativeDriver: false,
    }).start();
  }, [v, f]);

  return (
    <View style={{ width: 110, height: 210 }}>
      {/* 수은 기둥 */}
      <Animated.View
        style={{
          position: "absolute",
          left: 40,
          width: 20,
          bottom: 45,
          height: v.interpolate({ inputRange: [0, 1], outputRange: [16, 145] }),
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
          backgroundColor: color,
        }}
      />
      {/* 수은 저장고 */}
      <View
        style={{
          position: "absolute",
          left: 28,
          top: 158,
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: color,
        }}
      />
      {/* 유리 오버레이 */}
      <Image
        source={require("../../assets/thermometer-glass.png")}
        style={{ position: "absolute", width: 110, height: 210 }}
      />
    </View>
  );
}
