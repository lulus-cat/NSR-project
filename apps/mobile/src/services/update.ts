/**
 * 새 판 확인 — GitHub Releases 를 그대로 기준으로 쓴다.
 *
 * 판단 로직은 core 의 `release/update.ts` 에 있다. 여기는 네트워크를 부르고
 * 설정을 읽고 쓰는 일만 한다. 그래야 판단 쪽을 테스트할 수 있다.
 *
 * 스토어가 아니라 APK 로 나눠 쓰는 앱이라 이게 유일한 배포 경로다.
 * 그래서 "새 판이 나왔는지" 를 앱이 알려주지 않으면 아무도 모른다.
 */

import { Linking, Platform } from "react-native";
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
  message: "새 판을 확인하지 못했어요. 인터넷 연결을 확인해 주세요.",
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
    if (!auto) return { ...EMPTY, message: "자동 확인이 꺼져 있어요.", failed: false };

    const lastAt = await getSetting<number>(UPDATE_KEYS.lastCheckedAt, 0);
    // 토큰 없이 부르면 한 시간에 60번까지다. 자주 부르면 정작 필요할 때 막힌다.
    if (!isCheckDue(lastAt, now)) {
      return { ...EMPTY, message: "방금 확인했어요.", failed: false };
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
      // 404 를 "새 버전 없음"으로 읽으면 안 된다 — 저장소가 비공개일 때
      // GitHub 는 익명 요청에 404 를 준다. 없음과 접근 불가는 다른 사실이다.
      return {
        ...EMPTY,
        message:
          response.status === 404
            ? "새 판을 찾지 못했어요. 저장소가 닫혀 있는지 확인해 주세요."
            : "새 판을 확인하지 못했어요. 잠시 뒤 다시 해 주세요.",
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
    // '지금 확인'은 건너뛴 판도 다시 보여준다 — 손으로 눌렀다는 것이
    // 다시 보고 싶다는 뜻이다.
    skipped: force ? undefined : skipped || undefined,
  });

  // 수동 확인에서 '새 판 없음'이면 근거 숫자를 같이 보여준다.
  // 숫자 없이 '없습니다'만 보이면 버그로 읽힌다.
  const message =
    force && !decision.show && release
      ? `지금 ${currentVersion() ?? "?"} 판이에요. 새 판이 없어요.`
      : decision.message;

  return {
    ...decision,
    message,
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

/**
 * 새 판을 앱 안에서 받아 설치 화면까지 연다 (Android 전용).
 *
 * 브라우저를 거치지 않는다: APK 를 앱 캐시에 받고, FileProvider 의
 * content:// 주소로 안드로이드 패키지 설치 화면을 띄운다.
 * 설치 확인 자체는 OS 가 사람에게 직접 묻는다 — 앱이 대신 누를 수는 없고,
 * 그래서도 안 된다. 처음 한 번은 '이 앱의 출처 허용' 설정을 물을 수 있다.
 * iOS 나 실패 시에는 기존 브라우저 방식으로 돌아간다.
 */
export async function downloadAndInstall(
  release: ReleaseInfo,
  onProgress?: (pct: number) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (Platform.OS !== "android" || !release.apkUrl) {
    const opened = await openDownload(release);
    return opened ? { ok: true } : { ok: false, error: "내려받기 창을 열지 못했어요. 다시 눌러 주세요." };
  }
  const notifId = "nsr-app-update";
  // 받는 동안 포그라운드 서비스를 잡는다(beginWork) — 다른 앱을 봐도 안 끊기게.
  // 종료(endWork)는 성공·실패·예외 어느 길로 빠져도 정확히 한 번이어야 해서
  // finish 로 감싼다. 두 번 내리면 같이 돌던 전사의 서비스까지 꺼진다.
  let progress: typeof import("./progress-notify") | null = null;
  let ended = false;
  const finish = async (title?: string, body?: string) => {
    if (!progress || ended) return;
    ended = true;
    if (title) await progress.notifyDone(notifId, title, body ?? "");
    else await progress.endWork(notifId);
  };
  try {
    const { File, Paths } = await import("expo-file-system");
    progress = await import("./progress-notify");
    await progress.beginWork("새 판 받는 중", `NSR ${release.version} · 화면을 꺼도 계속돼요`);

    const target = new File(Paths.cache, `nsr-${release.version}.apk`);
    try {
      if (target.exists) target.delete();
    } catch {
      // 남은 옛 파일이 없으면 그만이다.
    }
    await File.downloadFileAsync(release.apkUrl, target, {
      idempotent: true,
      onProgress: ({ bytesWritten, totalBytes }) => {
        const pct = totalBytes > 0 ? Math.round((bytesWritten / totalBytes) * 100) : 0;
        onProgress?.(pct);
        void progress?.notifyProgress(
          notifId,
          pct,
          `받는 중 ${pct}%`,
          `NSR ${release.version} · 다 받으면 설치를 물어볼게요`,
        );
      },
    });
    if (!target.exists || target.size === 0) {
      await finish("받지 못했어요", "받아온 파일이 깨졌어요");
      return { ok: false, error: "받아온 파일이 깨졌어요. 다시 받아 주세요." };
    }
    await finish("다 받았어요", "설치 창을 열어드릴게요");

    const IntentLauncher = await import("expo-intent-launcher");
    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: target.contentUri,
      // FLAG_GRANT_READ_URI_PERMISSION — 설치기가 우리 파일을 읽게 허락한다.
      flags: 1,
      type: "application/vnd.android.package-archive",
    });
    return { ok: true };
  } catch (e) {
    await finish(); // 아직 안 끝냈으면 조용히 접는다.
    // 인앱 경로가 무엇에든 막히면 브라우저로라도 받게 한다.
    const fallback = await openDownload(release);
    if (fallback) return { ok: true };
    return { ok: false, error: e instanceof Error ? e.message : "받지 못했어요. 다시 해 주세요." };
  }
}
