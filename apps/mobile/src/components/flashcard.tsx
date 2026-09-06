/**
 * 암기 카드 한 장.
 *
 *  · 톡 치면 뒤집힌다 (앞 ↔ 뒤)
 *  · 오른쪽으로 밀면 외웠다, 왼쪽으로 밀면 더 볼래
 *
 * 움직임을 왜 이렇게 했나
 * ---------------------
 * 미는 동작은 **되먹임**이고 **자리의 이음새**다. 손이 민 방향으로 카드가 그대로
 * 나가고, 뒤에 겹쳐 있던 다음 장이 올라온다. 손가락을 따라가는 구간은 물리 그대로
 * (1:1, 곡선 없음), 놓았을 때만 용수철이 속도를 이어받는다. 뒤집기는 **상태 표시**라
 * 짧게 끊는다 — 200ms, 화면 안에서 모양이 바뀌는 움직임이라 ease-in-out 이다.
 *
 * reanimated 로 쓴다. RN 의 Animated 는 PanResponder 를 따라갈 때 네이티브 드라이버를
 * 못 써서 자바스크립트 실이 바쁠 때 프레임을 떨어뜨린다 — 목록을 읽어 오는 중에
 * 카드를 미는 것이 이 화면에서는 흔한 일이다.
 *
 * 움직임 줄이기(접근성)를 켜면 돌지 않는다. 뒤집기는 겹쳐 넘기기로, 나가는 것은
 * 흐려지는 것으로 바뀐다 — 없애는 것이 아니라 순하게 한다.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo, Dimensions, Text } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { radius, space, type, useTheme } from "../theme";

/** 이만큼 밀면 넘어간 것으로 본다. 짧으면 목록을 훑다 잘못 넘어간다. */
const THRESHOLD = 110;
/** 느리게 밀어도 이 속도를 넘기면 넘어간 것으로 본다 (툭 치고 놓는 손). */
const FLING = 700;
const OFF = Dimensions.get("window").width * 1.3;
/** 움직임 줄이기에서 카드가 물러나는 거리. 자리를 옮기지 않고 살짝만 민다. */
const CALM_OFF = 24;

/** 화면 안에서 모양이 바뀌는 움직임 — 강한 ease-in-out. */
const MORPH = Easing.bezier(0.77, 0, 0.175, 1);
/** 나가는 움직임 — 강한 ease-out. */
const LEAVE = Easing.bezier(0.23, 1, 0.32, 1);

export function Flashcard({
  front,
  back,
  hint,
  onAnswer,
}: {
  front: string;
  back: string;
  /** 뒷면 아래에 붙는 한 줄 (그날 들은 문장). */
  hint?: string;
  onAnswer: (known: boolean) => void;
}) {
  const t = useTheme();
  const [calm, setCalm] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setCalm);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setCalm);
    return () => sub.remove();
  }, []);

  const x = useSharedValue(0);
  /**
   * 나가는 중인가.
   *
   * reanimated 는 애니메이션이 끝나기 전에 값을 건드리면 콜백을 `finished=false`
   * 로 부른다(valueSetter.ts). 그걸 안 보면 한 번 민 카드가 두 번 답해지고, 그
   * 사이 한 장이 통째로 건너뛰어진다 — 안 보이고 다시 안 나온다.
   */
  const busy = useSharedValue(false);
  /** 0 앞면 · 1 뒷면. 그 사이 값이 도는 중이다. */
  const face = useSharedValue(0);
  /** 다음 장이 뒤에서 올라오는 값. 1 이면 제자리. */
  const rise = useSharedValue(1);
  const [flipped, setFlipped] = useState(false);
  const calmRef = useSharedValue(false);
  useEffect(() => {
    calmRef.value = calm;
  }, [calm, calmRef]);

  // 카드가 바뀌면 앞면·가운데에서 다시 시작한다. 뒤에서 올라오는 몸짓도 여기서 준다.
  useEffect(() => {
    x.value = 0;
    face.value = 0;
    setFlipped(false);
    rise.value = calm ? 1 : 0;
    rise.value = withSpring(1, { damping: 18, stiffness: 180 });
  }, [front, back, calm, x, face, rise]);

  /** 손이 아닌 길(접근성 동작)로 뒤집을 때. */
  const flip = () => {
    const to = flipped ? 0 : 1;
    setFlipped(!flipped);
    face.value = withTiming(to, { duration: calm ? 140 : 200, easing: MORPH });
  };

  const leave = (known: boolean) => {
    "worklet";
    if (busy.value) return;
    busy.value = true;
    // 움직임을 줄인 사람에게는 조금만 밀고 흐려지게 한다.
    const to = calmRef.value ? (known ? CALM_OFF : -CALM_OFF) : known ? OFF : -OFF;
    x.value = withTiming(to, { duration: calmRef.value ? 160 : 180, easing: LEAVE }, (finished) => {
      if (finished) runOnJS(onAnswer)(known);
      else busy.value = false;
    });
  };

  const pan = Gesture.Pan()
    // 세로로 그으면 목록이 스크롤돼야 한다. 가로로 확실히 그을 때만 잡는다.
    .activeOffsetX([-14, 14])
    .failOffsetY([-18, 18])
    .onChange((e) => {
      if (busy.value) return;
      x.value += e.changeX;
    })
    .onEnd((e, success) => {
      if (busy.value) return;
      // 앱이 뒤로 가거나 다른 손이 끼어들면 success 가 거짓으로 온다. 그때 밀린
      // 자리만 보고 답으로 치면, 사람이 주지 않은 점수가 기록된다.
      if (!success) {
        x.value = withSpring(0, { damping: 20, stiffness: 220 });
        return;
      }
      if (Math.abs(x.value) > THRESHOLD || Math.abs(e.velocityX) > FLING) {
        leave(x.value > 0);
        return;
      }
      // 놓았을 때만 용수철이다. 손가락이 남긴 속도를 이어받아야 튕겨 돌아온 느낌이 난다.
      x.value = withSpring(0, { damping: 20, stiffness: 220, velocity: e.velocityX });
    });

  const tap = Gesture.Tap()
    .maxDistance(10)
    .onEnd(() => {
      if (busy.value) return;
      // 뒤집힌 상태를 공유값에서 읽는다. React 상태로 읽으면 빠르게 두 번 눌렀을 때
      // 둘 다 같은 값을 보고 같은 곳으로 돌려서 두 번째 누름이 삼켜진다.
      const to = face.value < 0.5 ? 1 : 0;
      face.value = withTiming(to, { duration: calmRef.value ? 140 : 200, easing: MORPH });
      runOnJS(setFlipped)(to === 1);
    });

  const card = useAnimatedStyle(() => {
    // 흐려지는 정도는 '얼마나 갔나' 로 잰다. 움직임 줄이기는 24px 만 가므로
    // 같은 잣대(OFF)로 나누면 13% 밖에 안 흐려져서 나간 것이 안 보인다.
    const span = calmRef.value ? CALM_OFF : OFF;
    const away = Math.min(Math.abs(x.value) / span, 1);
    return {
      opacity: calmRef.value ? 1 - away * 0.9 : 1 - away * 0.4,
      transform: [
        { translateX: calmRef.value ? 0 : x.value },
        {
          rotate: calmRef.value
            ? "0deg"
            : `${interpolate(x.value, [-300, 0, 300], [-9, 0, 9], Extrapolation.CLAMP)}deg`,
        },
        // 뒤에서 올라오는 몸짓. 0 에서 시작하지 않는다 — 없던 것이 생기는 물건은 없다.
        { scale: calmRef.value ? 1 : interpolate(rise.value, [0, 1], [0.94, 1]) },
      ],
    };
  });

  // 두 면을 겹쳐 두고 뒷면만 미리 180도 돌려 둔다. 절반을 넘는 순간 보이는 면을
  // 바꿔서 뒷면이 뒤집힌 채로 비치지 않게 한다.
  // 움직임 줄이기에서는 돌지 않고 겹쳐 넘어간다.
  const frontFace = useAnimatedStyle(() =>
    calmRef.value
      ? { opacity: 1 - face.value }
      : {
          opacity: face.value < 0.5 ? 1 : 0,
          transform: [
            { perspective: 900 },
            { rotateY: `${interpolate(face.value, [0, 1], [0, 180])}deg` },
          ],
        },
  );
  const backFace = useAnimatedStyle(() =>
    calmRef.value
      ? { opacity: face.value }
      : {
          opacity: face.value < 0.5 ? 0 : 1,
          transform: [
            { perspective: 900 },
            { rotateY: `${interpolate(face.value, [0, 1], [180, 360])}deg` },
          ],
        },
  );

  const yes = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, THRESHOLD], [0, 1], Extrapolation.CLAMP),
  }));
  const no = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [-THRESHOLD, 0], [1, 0], Extrapolation.CLAMP),
  }));

  const faceBox = {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: space.lg,
    minHeight: 260,
    justifyContent: "center" as const,
    gap: space.md,
  };

  return (
    <GestureDetector gesture={Gesture.Race(pan, tap)}>
      <Animated.View
        accessibilityRole="button"
        accessibilityLabel={flipped ? `뒷면. ${back}` : `앞면. ${front}`}
        accessibilityHint="누르면 뒤집혀요. 오른쪽으로 밀면 외웠어요, 왼쪽으로 밀면 더 볼래요."
        accessibilityActions={[
          { name: "뒤집기", label: "뒤집기" },
          { name: "외웠어요", label: "외웠어요" },
          { name: "더 볼래요", label: "더 볼래요" },
        ]}
        onAccessibilityAction={(e) => {
          const what = e.nativeEvent.actionName;
          if (what === "외웠어요") onAnswer(true);
          else if (what === "더 볼래요") onAnswer(false);
          else flip();
        }}
        style={[{ minHeight: 260 }, card]}
      >
        <Animated.View style={[faceBox, { backgroundColor: t.surface, borderColor: t.border }, frontFace]}>
          <Text
            style={[
              type.body,
              { color: t.text, fontSize: 20, lineHeight: 30, textAlign: "center", fontWeight: "600" },
            ]}
          >
            {front}
          </Text>
          <Text style={[type.small, { color: t.textMuted, textAlign: "center" }]}>누르면 답</Text>
        </Animated.View>

        <Animated.View
          style={[
            faceBox,
            { backgroundColor: t.accentSoft, borderColor: t.border },
            { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
            backFace,
          ]}
        >
          <Text style={[type.body, { color: t.text, fontSize: 18, lineHeight: 28, textAlign: "center" }]}>
            {back}
          </Text>
          {hint ? (
            <Text style={[type.small, { color: t.textMuted, textAlign: "center" }]}>“{hint}”</Text>
          ) : null}
          <Text style={[type.small, { color: t.textMuted, textAlign: "center" }]}>누르면 앞면</Text>
        </Animated.View>

        {/* 손을 떼기 전에 무슨 일이 날지 보이게 하는 도장. 미는 값에 그대로 매인다 */}
        <Animated.View style={[{ position: "absolute", top: space.md, right: space.md }, yes]}>
          <Text style={{ fontSize: 15, fontWeight: "800", color: t.ok }}>외웠어요</Text>
        </Animated.View>
        <Animated.View style={[{ position: "absolute", top: space.md, left: space.md }, no]}>
          <Text style={{ fontSize: 15, fontWeight: "800", color: t.warn }}>더 볼래요</Text>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}
