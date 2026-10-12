/**
 * 진행률 표시 — 전사·모델 다운로드·업데이트가 같이 쓴다.
 *
 * 핵심은 알림이 아니라 **포그라운드 서비스**다. 다른 앱으로 넘어가면
 * Android 가 우리 프로세스를 얼려서(cached app freezer) 소켓이
 * "connection abort"로 끊기고 전사도 멈춘다 — 서비스를 잡고 있는 동안만
 * 면제된다. 서비스 알림이 곧 진행 표시다.
 *
 * 여러 작업이 겹칠 수 있어(다운로드 중 전사 시작) 참조 카운트로 서비스
 * 하나를 나눠 쓴다. 마지막 작업이 끝날 때만 내린다.
 * 서비스가 없는 환경(iOS 등)에서는 예전처럼 일반 알림으로만 보여준다.
 */

import { AppState } from "react-native";
import { getSetting, setSetting } from "../db";
import {
  workAlive,
  workNeedsMic,
  workStart,
  workStop,
  workProgress,
  workUpdate,
  type WorkStart,
} from "../../modules/nsr-audio-decode";

const lastPct = new Map<string, number>();
let workRefs = 0;
let fgsActive = false;
/** 마지막으로 서비스를 열려다 난 결과. 뒤에 오는 사람이 "왜 없는지" 를 알아야 한다. */
let lastStart: WorkStart = "unavailable";

export async function ensureNotifPermission(): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    const cur = await Notifications.getPermissionsAsync();
    if (!cur.granted && cur.canAskAgain) await Notifications.requestPermissionsAsync();
  } catch {
    // 없으면 없는 대로.
  }
}

/**
 * 작업 시작 — 포그라운드 서비스를 잡는다(가능한 환경에서).
 * 사용자가 버튼을 누른 직후(앱이 포그라운드일 때) 불러야 한다.
 */
export async function beginWork(
  title: string,
  body: string,
  mic = false,
  /** 거짓이면 알림 권한을 묻지 않는다 — 사람이 누르지 않은, 뒤에서 도는 일. */
  ask = true,
): Promise<WorkStart> {
  if (ask) await ensureNotifPermission();
  workRefs += 1;
  if (workRefs === 1) {
    lastStart = workStart(title, body, mic);
    fgsActive = lastStart === "started";
    return lastStart;
  }
  if (fgsActive) {
    // 내려받기가 먼저 서비스를 잡고 있다가 녹음이 시작되는 경우가 있다.
    // 그때 유형을 안 올리면 화면을 끄는 순간 마이크가 끊긴다.
    if (mic) workNeedsMic();
    workUpdate(title, body);
    return "started";
  }
  // 앞 사람이 열다 막혔으면("failed") 지금도 막힌 것이다. "unavailable" 로
  // 뭉개면 녹음이 아이폰인 줄 알고 서비스 없이 마이크를 켠다.
  return lastStart;
}

/**
 * 서비스가 정말 떠 있는가. null 은 모른다는 뜻(서비스가 없는 환경).
 *
 * startForeground 는 서비스 안에서 뒤늦게 거부될 수 있다(안드로이드 14, 앱이
 * 뒤에 있을 때). 그 실패는 beginWork 가 돌아온 뒤에 나서, 녹음이 조금 뒤에
 * 이걸로 되묻는다.
 */
export function serviceAlive(): boolean | null {
  if (!fgsActive) return null;
  return workAlive();
}

/**
 * 작업 종료. finalTitle 이 있으면 결과 알림을 하나 남긴다(일반 알림).
 * begin 과 반드시 짝을 이뤄야 한다 — 성공·실패·취소 모든 경로에서.
 */
export async function endWork(
  id: string,
  finalTitle?: string,
  finalBody?: string,
): Promise<void> {
  lastPct.delete(id);
  workRefs = Math.max(0, workRefs - 1);
  if (workRefs === 0 && fgsActive) {
    workStop();
    fgsActive = false;
  }
  if (finalTitle) {
    await postNotice(id, finalTitle, finalBody ?? "");
    return;
  }
  try {
    const Notifications = await import("expo-notifications");
    await Notifications.dismissNotificationAsync(id);
  } catch {
    // 알림은 편의다.
  }
}

/** 결과 알림 하나 (일반 알림 — 서비스와 따로 남는다). */
async function postNotice(id: string, title: string, body: string): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title, body, sound: false },
      trigger: null,
    });
  } catch {
    // 알림은 편의다.
  }
}

/** 진행 갱신. 5%p 단위로만 실제 표시를 바꾼다. */
export async function notifyProgress(
  id: string,
  percent: number,
  title: string,
  body: string,
): Promise<void> {
  const prev = lastPct.get(id) ?? -100;
  if (percent - prev < 5 && percent < 100) return;
  lastPct.set(id, percent);

  if (fgsActive) {
    workProgress(title, body, percent);
    return;
  }
  try {
    const Notifications = await import("expo-notifications");
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title, body, sound: false },
      trigger: null,
    });
  } catch {
    // 알림은 편의다. 실패해도 작업은 계속된다.
  }
}

/** 저절로 켜려다 막힌 것을 알리는 알림. 눌러서 앱을 열면 tick 이 이어받는다. */
const BLOCKED_ID = "recording-blocked";
/** 같은 알림을 다시 띄우는 간격. 병원에 있는 동안 15분 점검마다 울리면 안 된다. */
const BLOCKED_AGAIN_MS = 60 * 60_000;
const BLOCKED_AT_KEY = "recording.blockedNotifiedAt";

/**
 * 기록을 못 켰다고 알린다 (show=false 면 내린다).
 *
 * 안드로이드 12+ 는 앱이 뒤에 있을 때 마이크 포그라운드 서비스를 못 열게 한다.
 * 출근해서 병동에 들어가도 아무 일이 안 난 것처럼 보이는 유일한 길이 이것이라,
 * 조용히 넘기지 않고 눌러서 열 수 있는 알림을 남긴다.
 */
export async function notifyStartBlocked(show: boolean): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    if (!show) {
      await Notifications.dismissNotificationAsync(BLOCKED_ID);
      await setSetting(BLOCKED_AT_KEY, 0);
      return;
    }
    if (Date.now() - (await getSetting<number>(BLOCKED_AT_KEY, 0)) < BLOCKED_AGAIN_MS) return;
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await Notifications.scheduleNotificationAsync({
      identifier: BLOCKED_ID,
      content: {
        title: "앱이 뒤에 있어 기록을 못 켰어요",
        body: "눌러서 열면 바로 기록해요",
        sound: false,
      },
      trigger: null,
    });
    await setSetting(BLOCKED_AT_KEY, Date.now());
  } catch {
    // 알림은 편의다.
  }
}

/** endWork(id, title, body) 의 별칭 — 기존 호출부와의 이음새. */
export async function notifyDone(id: string, title: string, body: string): Promise<void> {
  await endWork(id, title, body);
}

/**
 * 무거운 반복 중에 화면이 숨 쉴 틈 — 앱이 앞에 있을 때만 준다.
 *
 * RN 은 앱이 뒤로 가면 JS 타이머를 세운다(JavaTimerManager 가 화면 틱마다 타이머를
 * 부르는데, 뒤에서는 그 틱이 안 돈다 — 0초 타이머도 마찬가지다). 그래서
 * `setTimeout(0)` 으로 쉬어 가던 가져오기·보내기가 사람이 다른 앱(클로드)으로 넘어가는
 * 순간 통째로 멈췄다. 10월 12일(590분)이 서버에 영영 안 간 까닭이다. 뒤에서는 그릴
 * 화면도 없으니 쉬지 않고 이어 간다. 쉬는 도중에 뒤로 가도 그 자리에서 풀린다.
 */
export function breathe(): Promise<void> {
  if (AppState.currentState !== "active") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.remove();
      resolve();
    };
    const timer = setTimeout(finish, 0);
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") finish();
    });
  });
}

/**
 * 지금 뒤에서 도는 일. 홈이 막대로 보여 준다 — 앱이 왜 바쁜지, 얼마나 남았는지
 * 사람이 알아야 한다. 예전엔 "· 100%" 한 줄뿐이라, 10시간 근무를 저장하는 몇 분 동안
 * 100% 에 멈춘 채 끝났는지 안 끝났는지 알 길이 없었다.
 */
export interface LiveStatus {
  title: string;
  /** 0~100 */
  pct: number;
  /** 지금 하는 일 — "10월 12일 수동 기록 · 교정하는 중 1200/7000문장" */
  detail: string;
}

/** 도는 일들. 겹치면(가져오기 안에서 보내기) 마지막에 시작한 것을 보여 준다. */
const works: { id: string; status: LiveStatus }[] = [];
const liveListeners = new Set<(status: LiveStatus | null) => void>();

function showLive(): void {
  const top = works.at(-1)?.status ?? null;
  for (const l of liveListeners) l(top);
}

export function onLiveStatus(listener: (status: LiveStatus | null) => void): () => void {
  liveListeners.add(listener);
  listener(works.at(-1)?.status ?? null);
  return () => {
    liveListeners.delete(listener);
  };
}

/** 알림을 longWork 가 쥐고 있다 — 그 안에서 도는 일은 같은 알림에 이어 적는다. */
let workNotice = false;

/**
 * 오래 걸리는 일을 포그라운드 서비스 아래에서 돌린다.
 *
 * 서비스가 없으면 다른 앱으로 넘어가는 순간 안드로이드가 앱을 얼린다(맨 위 주석).
 * 10시간 근무의 가져오기·보내기는 1분 안팎이 걸리는데, 사람은 그동안 클로드로 가서
 * "들어왔나" 를 묻는다. 진행은 알림과 홈에 막대로 같이 보인다.
 *
 * `done` 이 알림 글을 돌려주면 끝날 때 남긴다. 다른 앱에 가 있던 사람이 "다 됐나" 를
 * 아는 길은 그 알림뿐이다.
 *
 * 녹음이 이미 서비스를 잡고 있으면 그 알림을 덮어쓰지 않는다 — 녹음 서비스가 이미
 * 앱을 살려 두고 있다. 홈 막대만 바꾼다.
 */
export async function longWork<T>(
  id: string,
  title: string,
  run: (progress: (pct: number, detail: string) => void) => Promise<T>,
  done?: (result: T) => { title: string; body: string } | null,
): Promise<T> {
  const mine = workRefs === 0;
  const notify = mine || workNotice;
  if (mine) {
    await beginWork(title, "", false, false);
    workNotice = true;
  }
  const entry = { id, status: { title, pct: 0, detail: "" } };
  works.push(entry);
  showLive();
  let shownAt = 0;
  const progress = (pct: number, detail: string) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const moved = p !== entry.status.pct;
    entry.status = { title, pct: p, detail };
    // 교정은 25문장마다 알려 온다. 그때마다 홈을 다시 그리면 그 자체로 느려진다 —
    // 숫자가 바뀌었거나 0.5초가 지났을 때만 그린다.
    if (!moved && Date.now() - shownAt < 500) return;
    shownAt = Date.now();
    showLive();
    // 알림은 하나다. 겹친 일 중 위에 있는 것만 적는다 — 아래 것이 덮으면 깜빡인다.
    if (notify && works.at(-1) === entry) void notifyProgress(id, p, title, detail);
  };
  let final: { title: string; body: string } | null = null;
  try {
    const result = await run(progress);
    final = done?.(result) ?? null;
    return result;
  } finally {
    works.splice(works.indexOf(entry), 1);
    showLive();
    lastPct.delete(id); // 안 지우면 다음 판의 알림이 지난 판의 100% 에 걸려 안 바뀐다
    if (mine) {
      workNotice = false;
      await endWork(id, final?.title, final?.body);
    } else if (final) {
      await postNotice(id, final.title, final.body);
    }
  }
}

/**
 * 마지막으로 막힌 근무 — 티로에서 못 가져왔거나 서버로 못 보냈다. 홈이 까닭과 함께
 * 보여 준다. 예전엔 근무 기록 맨 아래 칸에만 적혀서, 사람이 그 화면을 찾아가야 알았다.
 */
export interface SyncProblem {
  shiftId: string;
  kind: "import" | "send";
  message: string;
  at: number;
}
const PROBLEM_KEY = "sync.problem";

export async function getSyncProblem(): Promise<SyncProblem | null> {
  return getSetting<SyncProblem | null>(PROBLEM_KEY, null);
}

export async function setSyncProblem(shiftId: string, kind: SyncProblem["kind"], message: string): Promise<void> {
  await setSetting(PROBLEM_KEY, { shiftId, kind, message, at: Date.now() } satisfies SyncProblem);
}

/** 그 근무가 풀렸으면 지운다. 다른 근무의 문제는 그대로 둔다. */
export async function clearSyncProblem(shiftId: string): Promise<void> {
  if ((await getSyncProblem())?.shiftId === shiftId) await setSetting(PROBLEM_KEY, null);
}
