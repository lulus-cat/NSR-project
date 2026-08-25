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
import { createSchedule, resolveAll, toDateString } from "@nsr/core";
import { getSetting, listDutyEntries, setSetting } from "../db";
import { searchHospitalsHira, searchPlacesKakao } from "./publicdata";
import { currentSession, startManual, stopManual } from "./scheduler";

export const GEOFENCE_TASK = "nsr-workplace-geofence";

export const GEO_KEYS = {
  workplace: "geofence.workplace",
  enabled: "geofence.enabled",
} as const;

export interface Workplace {
  latitude: number;
  longitude: number;
  /** 미터. 병원 건물 하나면 150 정도가 무난하다. */
  radius: number;
  label: string;
}

/** 오늘(또는 자정을 넘긴 어제 나이트) 근무가 있는가. */
async function isWorkingDay(now = Date.now()): Promise<{ working: boolean; shiftId: string }> {
  const entries = await listDutyEntries();
  const shifts = resolveAll(createSchedule(entries));
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
    if (eventType === Location.GeofencingEventType.Enter) {
      const enabled = await getSetting<boolean>(GEO_KEYS.enabled, false);
      if (!enabled) return;
      const day = await isWorkingDay();
      if (!day.working) return;
      if (!currentSession()) await startManual(day.shiftId);
      await setSetting("geofence.lastEnterAt", Date.now());
    } else if (eventType === Location.GeofencingEventType.Exit) {
      // 나가면 무조건 끈다. 근무지 밖의 대화는 이 앱이 다룰 것이 아니다.
      await stopManual();
      await setSetting("geofence.lastExitAt", Date.now());
    }
  } catch (e) {
    console.error("[NSR] 지오펜스 처리 실패", e);
  }
});

export async function getWorkplace(): Promise<Workplace | null> {
  return getSetting<Workplace | null>(GEO_KEYS.workplace, null);
}

export async function geofenceEnabled(): Promise<boolean> {
  return getSetting<boolean>(GEO_KEYS.enabled, false);
}

/**
 * 지금 서 있는 곳을 근무지로 지정한다.
 * 주소 검색을 넣지 않은 이유: 병동에서 이 버튼을 한 번 누르는 것이
 * 지도에서 병원을 찾아 찍는 것보다 정확하고 빠르다.
 */
export async function setWorkplaceHere(radius = 150): Promise<Workplace | null> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return null;
  const pos = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  const wp: Workplace = {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    radius,
    label: "근무지",
  };
  await setSetting(GEO_KEYS.workplace, wp);
  return wp;
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
    "검색 키가 없습니다. 설정 → 검색·데이터 키에서 카카오 REST 키(권장)나 공공데이터 키를 등록하십시오. 무료입니다.",
  );
}

/** 검색 결과를 근무지로 저장한다. 반경은 병원 부지를 감안해 넉넉히 250m. */
export async function setWorkplacePlace(hit: PlaceHit, radius = 250): Promise<Workplace> {
  const wp: Workplace = {
    latitude: hit.latitude,
    longitude: hit.longitude,
    radius,
    label: hit.name,
  };
  await setSetting(GEO_KEYS.workplace, wp);
  return wp;
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
  if (!wp) return { ok: false, message: "먼저 근무지를 지정하십시오." };

  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, message: "위치 권한이 필요합니다." };
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) {
    return {
      ok: false,
      message: "백그라운드 감지를 위해 위치 권한을 '항상 허용'으로 변경하십시오.",
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
    console.error("[NSR] 지오펜스 복구 실패", e);
  }
}
