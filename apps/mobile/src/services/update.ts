/**
 * 새 판 확인 — GitHub Releases 를 그대로 기준으로 쓴다.
 *
 * 판단 로직은 core 의 `release/update.ts` 에 있다. 여기는 네트워크를 부르고
 * 설정을 읽고 쓰는 일만 한다. 그래야 판단 쪽을 테스트할 수 있다.
 *
 * 스토어가 아니라 APK 로 나눠 쓰는 앱이라 이게 유일한 배포 경로다.
 * 그래서 "새 판이 나왔는지" 를 앱이 알려주지 않으면 아무도 모른다.
 */

import { Linking } from "react-native";
import Constants from "expo-constants";
import {
  decideUpdate,
  isCheckDue,
  pickLatestRelease,
  releaseListUrl,
  releaseHighlights,
  type ReleaseInfo,
  type UpdateDecision,
} from "@nsr/core";
import { getSetting, setSetting } from "../db";

/** 이 앱의 저장소. 릴리스를 여기서 본다. */
export const RELEASE_REPO = "lulus-cat/NSR-project";

export const UPDATE_KEYS = {
  lastCheckedAt: "update.lastCheckedAt",
  skippedVersion: "update.skippedVersion",
  /** 자동 확인을 끌 수 있게. 끄면 설정에서 손으로만 본다. */
  autoCheck: "update.autoCheck",
} as const;

/**
 * 지금 돌고 있는 앱의 판 번호.
 *
 * 개발 중(Expo Go, dev client)에는 없을 수 있다. 그때는 undefined 를 주고,
 * 판단 쪽이 "모르니까 알리지 않는다" 로 처리한다 — 늘 "새 판이다" 가 뜨는 것보다 낫다.
 */
export function currentVersion(): string | undefined {
  const v = Constants.expoConfig?.version;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface UpdateCheck extends UpdateDecision {
  release: ReleaseInfo | null;
  highlights: string[];
  /** 네트워크나 응답 문제로 확인 자체를 못 했는가. */
  failed: boolean;
}

const EMPTY: UpdateCheck = {
  show: false,
  reason: "none",
  message: "확인하지 못했습니다.",
  release: null,
  highlights: [],
  failed: true,
};

/**
 * 릴리스를 한 번 확인한다.
 *
 * @param force 시간 간격을 무시하고 지금 본다. 설정 화면의 "지금 확인" 용.
 */
export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  const now = Date.now();

  if (!force) {
    const auto = await getSetting<boolean>(UPDATE_KEYS.autoCheck, true);
    if (!auto) return { ...EMPTY, message: "자동 확인이 꺼져 있습니다.", failed: false };

    const lastAt = await getSetting<number>(UPDATE_KEYS.lastCheckedAt, 0);
    // 토큰 없이 부르면 한 시간에 60번까지다. 자주 부르면 정작 필요할 때 막힌다.
    if (!isCheckDue(lastAt, now)) {
      return { ...EMPTY, message: "최근에 확인했습니다.", failed: false };
    }
  }

  const url = releaseListUrl(RELEASE_REPO);
  if (!url) return EMPTY;

  let release: ReleaseInfo | null = null;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      return {
        ...EMPTY,
        message:
          response.status === 404
            ? "아직 올라온 판이 없습니다."
            : `확인하지 못했습니다 (${response.status}).`,
      };
    }
    release = pickLatestRelease(await response.json());
  } catch {
    // 병원 와이파이에서 막히는 경우가 실제로 있다. 조용히 넘어간다 —
    // 업데이트 확인 실패로 앱이 시끄러울 이유가 없다.
    return EMPTY;
  }

  await setSetting(UPDATE_KEYS.lastCheckedAt, now);

  const skipped = await getSetting<string>(UPDATE_KEYS.skippedVersion, "");
  const decision = decideUpdate({
    current: currentVersion(),
    latest: release,
    skipped: skipped || undefined,
  });

  return {
    ...decision,
    release,
    highlights: release ? releaseHighlights(release.notes) : [],
    failed: false,
  };
}

/** 이 판은 다시 안 알린다. 다음 판부터 다시 알린다. */
export async function skipVersion(version: string): Promise<void> {
  await setSetting(UPDATE_KEYS.skippedVersion, version);
}

export async function setAutoCheck(on: boolean): Promise<void> {
  await setSetting(UPDATE_KEYS.autoCheck, on);
}

export async function autoCheckEnabled(): Promise<boolean> {
  return getSetting<boolean>(UPDATE_KEYS.autoCheck, true);
}

/**
 * 받는 곳을 연다.
 *
 * 앱이 대신 설치해 줄 수는 없다 — 안드로이드는 설치할 때 반드시 사람이
 * 확인 화면을 눌러야 한다. 그래서 여기까지가 앱이 할 수 있는 전부다.
 * APK 주소가 있으면 바로 그걸, 없으면 릴리스 쪽을 연다.
 */
export async function openDownload(release: ReleaseInfo): Promise<boolean> {
  const target = release.apkUrl || release.pageUrl;
  if (!target) return false;
  try {
    await Linking.openURL(target);
    return true;
  } catch {
    return false;
  }
}
