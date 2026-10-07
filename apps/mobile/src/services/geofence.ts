/**
 * 근무지 지오펜스 — 병동에 들어오면 기록을 켜고, 나가면 끈다.
 *
 * 왜 필요한가
 * ----------
 * 듀티표 기반 자동 기록은 **근무표 시각**만 안다. 실제 간호사의 하루는
 * 근무표보다 이르게 시작하고 늦게 끝난다 — 그게 오버타임이고, 그 시간의
 * 대화가 기록에서 빠지면 안 된다. 위치는 근무표가 모르는 것을 안다:
 * "지금 병동에 있다"는 사실.
 *
 * 동작
 * ----
 *   근무지 반경 안으로 들어옴 → 기록 시작 (근무일일 때만)
 *   반경 밖으로 나감        → 기록 정지
 *
 * 근무일 판정을 하는 이유: 오프 날 병원 근처를 지나가거나 진료 보러 갔을 때
 * 기록이 켜지면 안 된다. 오늘 또는 어제(나이트가 자정을 넘는다) 근무가
 * 있을 때만 켠다. 출근 전 오버타임은 이 판정 안에서 자연히 덮인다 —
 * 근무일에 일찍 도착하면 그 순간부터 기록이니까.
 *
 * 정직한 한계
 * ----------
 * 안드로이드 14부터 백그라운드에서 마이크 포그라운드 서비스 시작이 제한된다.
 * 지오펜스 진입이 앱을 깨워도 기록 시작이 막힐 수 있다. 그 경우 앱을 한 번
 * 여는 순간 tick 이 이어받는다. 위치는 기기 밖으로 나가지 않는다.
 */
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import {
  clearStopLock,
  distanceMeters,
  geoDecision,
  reallyLeft,
  resolveAll,
  toDateString,
} from "@nsr/core";
import { getSetting, listDutyEntries, setSetting } from "../db";
import { withTimeout } from "./debug";
import { searchHospitalsHira, searchPlacesKakao } from "./publicdata";
import { buildSchedule, sessionOwner, startManual, stopManual } from "./scheduler";

export const GEOFENCE_TASK = "nsr-workplace-geofence";

export const GEO_KEYS = {
  workplace: "geofence.workplace",
  enabled: "geofence.enabled",
} as const;

/** 병원 부지를 감안한 기본값. 사람이 설정에서 바꾼다 (GEOFENCE_RADII). */
export const DEFAULT_RADIUS = 250;

export interface Workplace {
  latitude: number;
  longitude: number;
  /** 미터. 사람이 설정에서 고른다 (100·250·500·1000). 기본은 250. */
  radius: number;
  label: string;
}

/** 오늘(또는 자정을 넘긴 어제 나이트) 근무가 있는가. */
async function isWorkingDay(now = Date.now()): Promise<{ working: boolean; shiftId: string }> {
  const shifts = resolveAll(await buildSchedule());
  const today = toDateString(now);
  const yesterday = toDateString(now - 24 * 3600_000);
  const hit = shifts.find(
    (s) =>
      (s.date === today || s.date === yesterday) &&
      // 근무 전후 6시간까지를 그 근무의 오버타임 범위로 본다.
      now >= s.onSiteStartAt - 6 * 3600_000 &&
      now <= s.onSiteEndAt + 6 * 3600_000,
  );
  return hit
    ? { working: true, shiftId: hit.id }
    : { working: false, shiftId: `${today}:GEO` };
}

// 지오펜스 이벤트는 앱이 꺼져 있어도 온다. 태스크 정의는 모듈 평가 시점에
// 되어 있어야 한다 — 그래서 lazy import 없이 여기서 바로 정의한다.
TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { eventType } = data as { eventType: Location.GeofencingEventType };
  try {
    // **진입 신호는 그대로 믿는다.** 예전에는 신호를 버리고 위치를 새로 읽었는데,
    // 병원 안에서는 GPS 가 안 잡혀 그 한 번이 "밖" 으로 나오기 일쑤였다 — 그러면
    // 들어왔는데 기록이 안 켜진다. OS 의 지오펜스는 기지국·와이파이까지 보고
    // 판단하니 한 번 읽은 좌표보다 낫다.
    //
    // 이탈은 반대다. 튀는 값 하나로 근무 기록을 끊을 수 없어 syncByLocation 이
    // 위치를 다시 확인한다.
    if (eventType === Location.GeofencingEventType.Exit) await setSetting(PENDING_ENTER_KEY, 0);
    await syncByLocation(
      Date.now(),
      eventType === Location.GeofencingEventType.Enter ? "enter" : undefined,
    );
  } catch (e) {
    console.error("[앗] 위치 감지기 뻗음", e);
  }
});

/**
 * 지금 근무지에서 얼마나 떨어져 있는가.
 *
 * 이탈 신호를 되짚어 볼 때, 5분마다 도는 감시, 설정 화면의 '지금' 줄이 모두
 * 이 함수를 쓴다. 켜는 기준(inside)과 끄는 기준(left)을 따로 준다.
 */
export async function whereAmI(fresh = false): Promise<{
  /** 반경 안 — **켤 때** 쓰는 좁은 기준. */
  inside: boolean;
  /** 확실히 벗어남 — **끌 때** 쓰는 넉넉한 기준. */
  left: boolean;
  distance: number | null;
  radius: number;
} | null> {
  const wp = await getWorkplace();
  if (!wp) return null;
  try {
    // 실내에서는 GPS 가 안 잡혀 getCurrentPositionAsync 가 한참 붙잡힌다. OS 가
    // 깨운 태스크는 오래 살지 못해서, 한 번 읽겠다고 기다리다 꺼지면 아무 판단도
    // 못 한다. 다른 앱이 이미 받아 둔 1분 안쪽의 값이 있으면 그걸 쓴다.
    // 1분으로 조인 이유: 걸어 들어오는 중이면 묵은 값이 아직 '밖' 이라서,
    // 길면 그 판정만큼 기록이 늦는다.
    // 기록을 **끊기 전** 확인(fresh)만 새로 읽는다 — 묵은 값으로 끊으면 안 된다.
    const cached = fresh ? null : await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    // 저절로 읽는 위치는 '위치를 켜 주세요' 창을 띄우지 않는다. 띄우면 답이 올 때까지
    // 기다리는데, 앱이 뜨는 중이거나 뒤에 있을 때는 그 답이 안 온다. 시한도 둔다 —
    // 실내에서 위치가 안 잡히면 한참 걸린다.
    const pos =
      cached ??
      (await withTimeout(
        Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
          mayShowUserSettingsDialog: false,
        }),
        15_000,
        "위치를 15초 안에 못 읽었어요.",
      ));
    const distance = Math.round(distanceMeters(pos.coords, wp));
    // 켜는 기준과 끄는 기준이 달라야 한다. 같은 값을 쓰면 여유(±100m 이상)만큼
    // 밖에서도 기록이 켜진다 — 근무일에 병원 앞을 지나가기만 해도 켜진다.
    // 끄는 기준은 그 좌표의 오차까지 빼고 본다. 병원 안에서 기지국으로 잡힌 좌표는
    // 수백 미터씩 틀리고 오차도 그만큼 크게 온다 — 그 한 번에 끊으면 짧은 녹음만
    // 남는다. 오차 원이 통째로 밖일 때만 나갔다고 본다.
    const sure = Math.max(0, distance - (pos.coords.accuracy ?? 0));
    return { inside: distance <= wp.radius, left: reallyLeft(sure, wp.radius), distance, radius: wp.radius };
  } catch {
    // 못 읽었으면 '안에 있고 안 나갔다'로 본다. 못 읽었다는 이유로 끊는 것이
    // 잘못 끊는 것보다 나쁘다 (녹음은 다시 만들 수 없다).
    return { inside: false, left: false, distance: null, radius: wp.radius };
  }
}

/** 사람이 직접 끈 시각. 그 뒤에는 위치로 다시 켜지 않는다. */
const STOPPED_KEY = "geofence.stoppedByUserAt";

/**
 * 들어왔는데 기록을 못 켠 시각.
 *
 * 앱이 꺼져 있었거나(scheduler 의 uiAlive) 폰이 마이크를 막았을 때 남는다. 알림을
 * 눌러 앱이 열리면 위치를 못 읽어도 이걸로 켠다 — 병원 안은 위치가 안 잡히는 일이
 * 흔해서, 다시 읽어 확인하려 들면 눌렀는데도 안 켜진다. 나가면 지운다.
 */
const PENDING_ENTER_KEY = "geofence.pendingEnterAt";
const PENDING_ENTER_MS = 30 * 60_000;

/** 홈 화면에서 사람이 끄면 이걸 부른다. 위치 판정이 되살리지 못하게 막는다. */
export async function markStoppedByUser(at = Date.now()): Promise<void> {
  await setSetting(STOPPED_KEY, at);
}

/**
 * 위치를 보고 기록 상태를 맞춘다. 지오펜스 신호를 못 받았을 때의 안전망이다.
 *
 * 안드로이드는 진입·이탈 신호를 심심찮게 빠뜨린다 (실내, 절전, 신호 지연).
 * 그러면 병동에 들어왔는데 안 켜지거나, 퇴근했는데 계속 켜져 있다. 그래서
 * 신호를 기다리기만 하지 않고 **주기적으로 직접 본다** — tick(대개 15분)과,
 * 기록 중에는 5분마다 도는 아래 감시가 이 함수를 부른다.
 *
 * 무엇을 켜고 끌지는 `@nsr/core` 의 geoDecision 이 정한다. 거기 시험이 있다.
 */
export async function syncByLocation(
  now = Date.now(),
  /** OS 가 "들어왔다" 고 알려 준 경우. 위치를 다시 읽지 않고 그대로 믿는다. */
  hint?: "enter",
): Promise<void> {
  if (!(await geofenceEnabled())) return;
  const here = hint === "enter" ? null : await whereAmI();
  const clearlyLeft = here?.left === true;
  // 방금 들어와 못 켠 표시가 남아 있으면, 확실히 나간 게 아닌 한 안이라고 본다.
  // OS 의 진입 판단을 병원 안에서 한 번 읽은 좌표보다 믿는다 (위 defineTask 와 같은 이유).
  const pendingAt = await getSetting<number>(PENDING_ENTER_KEY, 0);
  const entered =
    hint === "enter" ||
    (!clearlyLeft && pendingAt > 0 && now - pendingAt < PENDING_ENTER_MS);
  if (!entered && (!here || here.distance === null)) return; // 위치를 못 읽으면 건드리지 않는다
  const inside = entered || here?.inside === true;
  const left = !entered && clearlyLeft;
  if (left && pendingAt > 0) await setSetting(PENDING_ENTER_KEY, 0);

  // 밖으로 나왔으면 '사람이 직접 끔' 잠금을 푼다. 이걸 안 풀어서, 홈에서 기록을
  // 한 번 끄면 그 뒤로는 출근해도 위치로 안 켜졌다 (잠금을 푸는 곳이 없었다).
  let stoppedAt = await getSetting<number>(STOPPED_KEY, 0);
  if (clearStopLock(left, stoppedAt, now)) {
    await setSetting(STOPPED_KEY, 0);
    stoppedAt = 0;
  }

  const day = await isWorkingDay(now);
  const act = geoDecision({
    session: sessionOwner(),
    inside,
    left,
    working: day.working,
    stoppedByUserAt: stoppedAt,
    shiftId: day.shiftId,
  });

  if (act.do === "start") {
    // 켜졌는지 확인하고 적는다. 예전에는 실패해도 '들어온 시각' 을 적고 감시
    // 타이머까지 걸어서, 화면만 보면 다 된 것 같았다.
    // 못 켠 경우(안드로이드가 뒤에서 마이크를 막는다)는 scheduler 가 알림을 띄운다.
    if (await startManual(act.shiftId, now, "geofence")) {
      await setSetting(PENDING_ENTER_KEY, 0);
      await setSetting("geofence.lastEnterAt", now);
      watchExit();
    } else if (hint === "enter") {
      // 못 켰다 — 들어온 것만 적어 둔다. 알림을 눌러 앱이 열리면 이걸로 켠다.
      // 진입 신호일 때만 적는다. 이 표시로 다시 시도한 것까지 적으면 영영 안 삭는다.
      await setSetting(PENDING_ENTER_KEY, now);
    }
  } else if (act.do === "stop") {
    // 끊기 전에 한 번 더, 이번엔 새로 읽어서 본다. 튀는 값 하나에 근무 기록이
    // 끝나면 안 된다.
    const again = await whereAmI(true);
    if (!again?.left) return;
    await stopManual();
    await setSetting("geofence.lastExitAt", now);
    clearExitWatch();
  }
}

/**
 * 설정 화면의 '지금' 줄 — 어디인지와, **안 켜지는 이유**.
 *
 * 거리만 보여 주던 시절에는 "근무지 안 · 30m" 인데 기록이 없는 날 이유를 알 수
 * 없었다. 안 켜지는 까닭은 셋이다: 근무일이 아니다 / 직접 끈 뒤다 / 밖이다.
 */
export async function geoStatus(now = Date.now()): Promise<string> {
  // 안드로이드는 오래 안 쓴 권한을 저절로 거둔다. '항상 허용' 이 빠지면 지오펜스
  // 신호가 조용히 끊기는데, 설정 화면은 그동안 '켜짐' 이라고 적고 있었다.
  if (await geofenceEnabled()) {
    const bg = await Location.getBackgroundPermissionsAsync();
    if (!bg.granted) return "위치 '항상 허용' 이 꺼졌어요";
  }
  const here = await whereAmI();
  if (!here) return "근무지 없음";
  if (here.distance === null) return "위치를 못 읽었어요";
  const where = here.inside ? `근무지 안 · ${here.distance}m` : `밖 · ${here.distance}m`;
  if (sessionOwner()) return `${where} · 기록 중`;
  if (!here.inside) return where;
  if (!(await isWorkingDay(now)).working) return `${where} · 오늘 근무가 없어요`;
  if ((await getSetting<number>(STOPPED_KEY, 0)) !== 0) return `${where} · 직접 끈 뒤예요`;
  return `${where} · 곧 켜져요`;
}

/**
 * 기록 중 5분마다 "아직 병동인가"를 본다.
 *
 * 이탈 신호 하나만 믿으면, 그 신호가 안 오는 날 퇴근 뒤에도 기록이 계속 돈다.
 * 기록 중에는 포그라운드 서비스를 잡고 있어 이 타이머가 확실히 돈다 —
 * 기록이 아닐 때는 OS 가 앱을 재우므로 tick(15분)이 대신 본다.
 */
const EXIT_WATCH_MS = 5 * 60_000;
let exitWatch: ReturnType<typeof setInterval> | null = null;

function watchExit(): void {
  if (exitWatch) return;
  exitWatch = setInterval(() => {
    void (async () => {
      if (sessionOwner()?.owner !== "geofence") {
        clearExitWatch();
        return;
      }
      await syncByLocation();
    })();
  }, EXIT_WATCH_MS);
}

function clearExitWatch(): void {
  if (exitWatch) clearInterval(exitWatch);
  exitWatch = null;
}

export async function getWorkplace(): Promise<Workplace | null> {
  return getSetting<Workplace | null>(GEO_KEYS.workplace, null);
}

export async function geofenceEnabled(): Promise<boolean> {
  return getSetting<boolean>(GEO_KEYS.enabled, false);
}

/** 근무지를 저장한 결과. message 가 있으면 다시 거는 데 실패한 것이다. */
export interface SavedWorkplace {
  workplace: Workplace;
  message?: string;
}

/**
 * 근무지를 저장하고, 켜져 있으면 **새 좌표로 다시 건다.**
 *
 * 다시 거는 것을 잊으면 OS 는 예전 좌표를 계속 본다 — 병원을 바꿔 놓고 출근해도
 * 기록이 안 켜지는 길이었다(반경을 바꿀 때만 다시 걸고 있었다). 좌표·반경·현재
 * 위치 세 갈래가 모두 이 함수를 지난다.
 *
 * 다시 걸다 막히면(그사이 권한이 빠졌다든지, 위치 서비스가 꺼졌다든지) 삼키지
 * 않고 돌려준다. 삼키면 화면은 켜진 것처럼 보이고 출근해도 아무 일이 안 난다.
 */
async function saveWorkplace(wp: Workplace): Promise<SavedWorkplace> {
  await setSetting(GEO_KEYS.workplace, wp);
  if (!(await geofenceEnabled())) return { workplace: wp };
  await setGeofence(false);
  try {
    const r = await setGeofence(true);
    if (!r.ok) return { workplace: wp, message: r.message };
  } catch (e) {
    return {
      workplace: wp,
      message:
        e instanceof Error ? e.message : "근무지 감지를 다시 켜지 못했어요. 위치를 켜 주세요.",
    };
  }
  return { workplace: wp };
}

/**
 * 지금 서 있는 곳을 근무지로 지정한다.
 * 주소 검색을 넣지 않은 이유: 병동에서 이 버튼을 한 번 누르는 것이
 * 지도에서 병원을 찾아 찍는 것보다 정확하고 빠르다.
 */
export async function setWorkplaceHere(radius = DEFAULT_RADIUS): Promise<SavedWorkplace | null> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return null;
  const pos = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  return saveWorkplace({
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    radius,
    label: "내 병원 (근무지)",
  });
}

/** 병원 이름으로 좌표 찾기. */
export interface PlaceHit {
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * 병원 검색 — 카카오(지도 앱과 같은 데이터)가 1순위, 없으면 심평원.
 * OSM 은 뺐다: 실기기에서 한국 병원 인식률이 낮아 검색이 안 되는 것처럼 보였다.
 * 키가 하나도 없으면 조용히 빈 결과를 주지 않고 어디서 키를 넣는지 말한다.
 */
export async function searchWorkplace(
  query: string,
): Promise<{ hits: PlaceHit[]; source: "kakao" | "hira" }> {
  const kakao = await searchPlacesKakao(query);
  if (kakao) {
    return {
      hits: kakao.map((p) => ({
        name: p.address ? `${p.name} — ${p.address}` : p.name,
        latitude: p.latitude,
        longitude: p.longitude,
      })),
      source: "kakao",
    };
  }
  const hira = await searchHospitalsHira(query);
  if (hira) {
    return {
      hits: hira.map((h) => ({
        name: h.address ? `${h.name} — ${h.address}` : h.name,
        latitude: h.latitude,
        longitude: h.longitude,
      })),
      source: "hira",
    };
  }
  throw new Error(
    "검색 열쇠가 없어요. 설정에서 카카오·공공데이터 열쇠를 넣어 주세요.",
  );
}

/** 검색 결과를 근무지로 저장한다. 반경은 설정 화면에서 고른 값이다. */
export async function setWorkplacePlace(
  hit: PlaceHit,
  radius = DEFAULT_RADIUS,
): Promise<SavedWorkplace> {
  return saveWorkplace({
    latitude: hit.latitude,
    longitude: hit.longitude,
    radius,
    label: hit.name,
  });
}

/**
 * 반경만 바꾼다. 병원 규모가 제각각이라(작은 의원부터 대학병원 부지까지)
 * 사람이 고르는 값이다. 켜져 있으면 새 반경으로 다시 건다.
 */
export async function setRadius(radius: number): Promise<SavedWorkplace | null> {
  const wp = await getWorkplace();
  if (!wp) return null;
  return saveWorkplace({ ...wp, radius });
}

export async function clearWorkplace(): Promise<void> {
  await setGeofence(false);
  await setSetting(GEO_KEYS.workplace, null);
}

/** 지오펜스를 켜고 끈다. 켜려면 위치 "항상 허용"이 필요하다. */
export async function setGeofence(on: boolean): Promise<{ ok: boolean; message?: string }> {
  if (!on) {
    await setSetting(GEO_KEYS.enabled, false);
    try {
      if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
        await Location.stopGeofencingAsync(GEOFENCE_TASK);
      }
    } catch {
      // 이미 안 돌고 있으면 그만이다.
    }
    return { ok: true };
  }

  const wp = await getWorkplace();
  if (!wp) return { ok: false, message: "근무지가 없어요. 병원 위치부터 정해 주세요." };

  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, message: "위치 사용이 꺼져 있어요. 폰 설정에서 켜 주세요." };
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) {
    return {
      ok: false,
      message: "앱을 열지 않아도 켜지게 하려면 위치를 '항상 허용'으로 바꿔 주세요.",
    };
  }

  await Location.startGeofencingAsync(GEOFENCE_TASK, [
    {
      identifier: "workplace",
      latitude: wp.latitude,
      longitude: wp.longitude,
      radius: wp.radius,
      notifyOnEnter: true,
      notifyOnExit: true,
    },
  ]);
  await setSetting(GEO_KEYS.enabled, true);
  return { ok: true };
}

/** 앱 시작 시 상태 복구 — 켜 두었는데 OS 가 지웠으면 다시 건다. */
export async function restoreGeofence(): Promise<void> {
  try {
    const enabled = await geofenceEnabled();
    if (!enabled) return;
    if (!(await Location.hasStartedGeofencingAsync(GEOFENCE_TASK))) {
      await setGeofence(true);
    }
  } catch (e) {
    console.error("[NSR] 위치 감지 재시작 실패", e);
  }
}
