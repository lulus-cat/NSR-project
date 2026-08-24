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
  registerBackgroundTask,
  savePolicy,
  tick,
  upcomingWindows,
} from "../services/scheduler";

export interface AppStateValue {
  ready: boolean;
  /** 최초 고지·동의를 마쳤는가. 마치기 전에는 녹음 기능을 켤 수 없다. */
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
  if (!value) throw new Error("AppProvider 안에서만 사용할 수 있습니다.");
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

  const unlock = useCallback(async () => {
    if (!appLockEnabled.current) {
      setLocked(false);
      return true;
    }
    const LocalAuthentication = await import("expo-local-authentication");
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !enrolled) {
      // 생체인증을 쓸 수 없는 기기에서 앱이 통째로 잠기면 안 된다.
      setLocked(false);
      return true;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "녹음에는 환자 정보가 포함될 수 있습니다",
      cancelLabel: "취소",
    });
    setLocked(!result.success);
    return result.success;
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
    let cancelled = false;
    void (async () => {
      const lock = await getSetting<boolean>(SETTINGS_KEYS.appLock, false);
      appLockEnabled.current = lock;
      if (lock) setLocked(true);
      await registerBackgroundTask();
      await refresh();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // 앱이 앞으로 나올 때마다 한 번 더 확인한다.
  // iOS에서는 이 시점이 녹음이 시작되는 유일한 확실한 기회다.
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === "active") {
        if (appLockEnabled.current) setLocked(true);
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
