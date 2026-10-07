import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import {
  DEFAULT_RECORDING_POLICY,
  type RecordingPolicy,
  type RecordingWindow,
} from "@nsr/core";
import { getSetting, setSetting } from "../db";
import {
  SETTINGS_KEYS,
  loadPolicy,
  markUiAlive,
  registerBackgroundTask,
  savePolicy,
  tick,
  upcomingWindows,
} from "../services/scheduler";
import { restoreGeofence } from "../services/geofence";
import { withTimeout } from "../services/debug";

export interface AppStateValue {
  ready: boolean;
  /** 최초 고지·동의를 마쳤는가. 마치기 전에는 기록 기능을 켤 수 없다. */
  onboarded: boolean;
  /** 앱 잠금이 켜져 있고 아직 인증하지 않은 상태. */
  locked: boolean;
  policy: RecordingPolicy;
  recording: boolean;
  currentWindow: RecordingWindow | null;
  nextWindow: RecordingWindow | null;
  unlock: () => Promise<boolean>;
  completeOnboarding: () => Promise<void>;
  updatePolicy: (next: RecordingPolicy) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppStateValue | null>(null);

export function useApp(): AppStateValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("엥? AppProvider 품속에서만 놀 수 있어요!");
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [locked, setLocked] = useState(false);
  const [policy, setPolicy] = useState<RecordingPolicy>(DEFAULT_RECORDING_POLICY);
  const [recording, setRecording] = useState(false);
  const [currentWindow, setCurrentWindow] = useState<RecordingWindow | null>(null);
  const [nextWindow, setNextWindow] = useState<RecordingWindow | null>(null);
  const appLockEnabled = useRef(false);

  const refresh = useCallback(async () => {
    const [nextPolicy, done, lock] = await Promise.all([
      loadPolicy(),
      getSetting<boolean>(SETTINGS_KEYS.onboarded, false),
      getSetting<boolean>(SETTINGS_KEYS.appLock, false),
    ]);
    setPolicy(nextPolicy);
    setOnboarded(done);
    appLockEnabled.current = lock;

    const result = await tick(Date.now());
    setRecording(result.recording);
    setCurrentWindow(result.window);
    setNextWindow(result.next ?? (await upcomingWindows())[0] ?? null);
  }, []);

  // 인증 겹침 방지용. 0 이면 쉬는 중, 아니면 프롬프트를 띄운 시각이다.
  // 시각으로 두는 이유: 프롬프트가 끝맺지 못한 채 앱이 밀려나도
  // 15초가 지나면 스스로 풀려서 버튼이 영영 죽는 일이 없다.
  const authStartedAt = useRef(0);

  const unlock = useCallback(async () => {
    if (!appLockEnabled.current) {
      setLocked(false);
      return true;
    }
    const now = Date.now();
    if (now - authStartedAt.current < 15_000) return false;
    authStartedAt.current = now;
    try {
      const LocalAuthentication = await import("expo-local-authentication");
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !enrolled) {
        // 생체인증을 쓸 수 없는 기기에서 앱이 통째로 잠기면 안 된다.
        setLocked(false);
        return true;
      }
      // 이전 인증이 앱 전환 등으로 끝맺지 못하고 걸려 있으면 안드로이드가
      // 새 프롬프트를 조용히 무시한다 — "버튼을 눌러도 인증 화면이 안 뜨는"
      // 증상의 원인. 시작 전에 걸린 것을 걷어낸다.
      try {
        await LocalAuthentication.cancelAuthenticate();
      } catch {
        // 걸린 인증이 없으면 그만이다.
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "환자 정보 털릴 수 있음 주의",
        cancelLabel: "앗차차 (취소)",
        // 생체인식이 거듭 실패하면 기기 잠금(PIN·패턴)으로도 풀 수 있게.
        disableDeviceFallback: false,
      });
      setLocked(!result.success);
      return result.success;
    } finally {
      authStartedAt.current = 0;
    }
  }, []);

  const completeOnboarding = useCallback(async () => {
    await setSetting(SETTINGS_KEYS.onboarded, true);
    setOnboarded(true);
  }, []);

  const updatePolicy = useCallback(async (next: RecordingPolicy) => {
    await savePolicy(next);
    setPolicy(next);
    const result = await tick(Date.now());
    setRecording(result.recording);
    setCurrentWindow(result.window);
    setNextWindow(result.next);
  }, []);

  useEffect(() => {
    // 화면이 있는 실행판이다 — 여기서 켠 녹음은 앱이 뒤로 가도 살아 있다.
    // 아래 첫 tick 보다 먼저 알려야 지금 켤 녹음이 알림으로 새지 않는다.
    markUiAlive();
    let cancelled = false;
    void (async () => {
      // 화면을 띄우는 데 필요한 것은 둘뿐이다 — 잠금 여부와 첫 고지를 마쳤는지.
      // 둘 다 DB 한 줄이라 금방이다. 잠금은 못 읽으면 **잠근 쪽**으로 — 열어 두는
      // 실수보다 낫다.
      let lock = true;
      try {
        const [lockOn, done] = await Promise.all([
          getSetting<boolean>(SETTINGS_KEYS.appLock, false),
          getSetting<boolean>(SETTINGS_KEYS.onboarded, false),
        ]);
        lock = lockOn;
        setOnboarded(done);
      } catch (e) {
        console.error("[NSR] 시작 단계 실패", e);
      } finally {
        appLockEnabled.current = lock;
        if (lock) setLocked(true);
      }
      if (cancelled) return;
      setReady(true);

      // 나머지는 화면을 띄운 **뒤에** 한다. 예전에는 이것까지 다 기다렸다가 화면을
      // 띄웠는데, 첫 tick 이 위치(GPS·'위치를 켜 주세요' 창)나 녹음기(서비스 연결)를
      // 기다리다 영영 안 끝나면 시작 화면에서 못 빠져나왔다 — 한 번 쓰고 녹음한
      // 다음 실행부터 무한 로딩이던 것. try 는 던지는 것만 잡고 멈춘 것은 못 잡는다.
      // 하나가 막혀도 다음 것은 돈다 (시한은 기다림만 끊고 일은 그대로 둔다).
      for (const [name, step] of [
        ["백그라운드 작업 등록", registerBackgroundTask],
        ["근무지 감지 다시 걸기", restoreGeofence],
        ["첫 확인", refresh],
      ] as const) {
        try {
          await withTimeout(step(), 30_000, `앱을 열 때 '${name}'이 끝나지 않았어요.`);
        } catch (e) {
          console.error("[NSR] 시작 단계 실패", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // 앱이 앞으로 나올 때마다 한 번 더 확인한다.
  // iOS에서는 이 시점이 기록이 시작되는 유일한 확실한 기회다.
  //
  // 재잠금에는 30초 유예를 둔다. 마이크 권한 다이얼로그·생체인증 프롬프트·
  // 알림창 같은 짧은 이탈도 background→active 를 만드는데, 그때마다 잠그면
  // "기록 시작을 눌렀더니 잠금화면이 뜨는" 황당한 흐름이 된다.
  const leftAt = useRef(0);
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === "background") leftAt.current = Date.now();
      if (state === "active") {
        const away = leftAt.current > 0 ? Date.now() - leftAt.current : 0;
        if (appLockEnabled.current && away > 30_000) setLocked(true);
        void refresh();
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, [refresh]);

  const value = useMemo<AppStateValue>(
    () => ({
      ready,
      onboarded,
      locked,
      policy,
      recording,
      currentWindow,
      nextWindow,
      unlock,
      completeOnboarding,
      updatePolicy,
      refresh,
    }),
    [
      ready,
      onboarded,
      locked,
      policy,
      recording,
      currentWindow,
      nextWindow,
      unlock,
      completeOnboarding,
      updatePolicy,
      refresh,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
