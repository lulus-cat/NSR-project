/**
 * 디버그 — 앱 안에서 일어난 오류를 붙잡아 두고, 버그 신고를 한 번에 만든다.
 *
 * 원격에서 "어떤 오류였는지"를 알 수 없으면 고칠 수도 없다. 그래서
 *  1. JS 전역 오류를 링버퍼(최근 50개)로 남기고
 *  2. 설정의 디버그 카드에서 보여주고
 *  3. 기기·판 정보와 함께 GitHub 새 이슈 주소로 만들어 브라우저로 넘긴다.
 *
 * 이슈 제출은 앱이 하지 않는다 — 익명 토큰 없이는 불가능하고, 사용자가
 * 브라우저에서 내용을 확인하고 제출하는 쪽이 개인정보에도 옳다.
 */

import { Platform } from "react-native";
import Constants from "expo-constants";
import { getSetting, setSetting } from "../db";
import { redactForNetwork } from "./export";
import { RELEASE_REPO, currentVersion } from "./update";

const LOG_KEY = "debug.log";
const MAX_ENTRIES = 50;

export interface DebugEntry {
  at: number;
  /** "error" = 전역 핸들러가 잡은 것, "log" = 코드가 직접 남긴 것. */
  kind: "error" | "log";
  message: string;
}

export async function readDebugLog(): Promise<DebugEntry[]> {
  return getSetting<DebugEntry[]>(LOG_KEY, []);
}

export async function clearDebugLog(): Promise<void> {
  await setSetting(LOG_KEY, []);
}

export async function logDebug(message: string, kind: DebugEntry["kind"] = "log"): Promise<void> {
  const entries = await readDebugLog();
  entries.push({ at: Date.now(), kind, message: message.slice(0, 600) });
  await setSetting(LOG_KEY, entries.slice(-MAX_ENTRIES));
}

let installed = false;

/** 앱 시작 시 한 번. JS 전역 오류를 기록하되 기존 처리(빨간 화면 등)는 그대로 둔다. */
export function installGlobalErrorLog(): void {
  if (installed) return;
  installed = true;
  const utils = (globalThis as { ErrorUtils?: {
    getGlobalHandler(): (e: unknown, fatal?: boolean) => void;
    setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void;
  } }).ErrorUtils;
  if (!utils) return;
  const prev = utils.getGlobalHandler();
  utils.setGlobalHandler((e, fatal) => {
    const msg = e instanceof Error ? `${e.message}\n${(e.stack ?? "").split("\n").slice(0, 4).join("\n")}` : String(e);
    void logDebug(`${fatal ? "[대참사] " : ""}${msg}`, "error");
    prev(e, fatal);
  });
}

function formatTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * GitHub 새 이슈 프리필 주소. 열면 제목·본문이 채워진 채로 브라우저가 뜬다.
 * 로그는 비식별화를 거치고, URL 길이 제한 때문에 최근 몇 개만 싣는다.
 */
export async function buildIssueUrl(userNote?: string): Promise<string> {
  const entries = (await readDebugLog()).slice(-8);
  const lines = entries.map((e) => `- ${formatTime(e.at)} [${e.kind}] ${e.message.split("\n")[0]}`);
  const logBlock = lines.length > 0 ? (await redactForNetwork(lines.join("\n"))).text : "(오 평화롭다 뻗은 기록 없음)";

  const body = [
    "## 대체 무슨 일이 있었나",
    userNote?.trim() || "(여기다 썰 좀 풀어주세요 — 어떤 화면에서, 뭘 찔렀을 때 폰이 뻗었는지)",
    "",
    "## 폰 상태 (환경)",
    `- 앱 나이(버전): ${currentVersion() ?? "뚝딱뚝딱 개발 중"}`,
    `- OS: ${Platform.OS} ${Platform.Version}`,
    `- 내 폰: ${Constants.deviceName ?? "?"}`,
    "",
    "## 방금 터진 에러 로그 (알아서 복붙할게요, 정보는 모자이크 처리 완)",
    logBlock,
  ].join("\n");

  const title = encodeURIComponent(`[버그 출몰] ${userNote?.trim().slice(0, 60) || "앱이 미쳤어요 (에러 보고)"}`);
  return `https://github.com/${RELEASE_REPO}/issues/new?title=${title}&body=${encodeURIComponent(body.slice(0, 5500))}`;
}
