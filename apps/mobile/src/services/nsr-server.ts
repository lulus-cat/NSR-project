/**
 * 분석 서버(VPS) 연결 — 근무를 올리고, AI 가 만든 결과를 받아온다.
 *
 * 무엇이 올라가나
 * --------------
 * **가린 문장만.** 문장 하나하나가 `redactForNetwork` 를 지나고, 지나지 않은
 * 것은 아예 만들지 않는다. 원본(rawText)·오디오·화자 이름·태움 문장은 여기
 * 근처에도 오지 않는다 (docs/08, `nsr-privacy` 스킬).
 *
 * 서버도 한 번 더 본다 — `masked: true` 가 없거나 전화번호 같은 것이 남아 있으면
 * 받지 않고 돌려보낸다. 서버가 대신 가려 주지는 않는다. 가리는 자리는 폰이다.
 *
 * 무엇이 내려오나
 * --------------
 * 대화 AI 가 써 넣은 근무 보고서와, 대화 중에 배운 병동 용어. 받은 것은 "받았다"고
 * 알려 줘서 같은 것을 두 번 붙이지 않는다.
 *
 * 열쇠 두 개
 * ---------
 * 기기 토큰은 이 앱이 자료를 올릴 때 쓴다 — `expo-secure-store` 에만 둔다(규칙 7).
 * 대화 AI 가 쓰는 열쇠는 이 앱에 없다. 그건 커넥터를 연결할 때 사람이 넣는다.
 */
import * as SecureStore from "expo-secure-store";
import {
  getSetting,
  getTaeumScore,
  listSegments,
  listUserTerms,
  saveShiftReport,
  saveUserTerm,
  setSetting,
} from "../db";
import { redactForNetwork } from "./export";
import { logDebug } from "./debug";

const URL_KEY = "nsr.server.url";
const TOKEN_KEY = "nsr.server.deviceToken";

export interface ServerSettings {
  url: string;
  hasToken: boolean;
}

/** 주소는 비밀이 아니라 설정에 둔다. 토큰은 보안 저장소에만 둔다. */
export async function getServerUrl(): Promise<string> {
  return (await getSetting<string>(URL_KEY, "")) ?? "";
}

export async function setServerUrl(url: string): Promise<void> {
  // 끝의 빗금은 붙이는 쪽에서 늘 틀린다. 여기서 한 번 정리한다.
  await setSetting(URL_KEY, url.trim().replace(/\/+$/, ""));
}

export async function getDeviceToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setDeviceToken(token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token.trim());
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function serverReady(): Promise<boolean> {
  return !!(await getServerUrl()) && !!(await getDeviceToken());
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const url = await getServerUrl();
  const token = await getDeviceToken();
  if (!url) throw new Error("서버 주소가 없어요. 설정에서 넣어 주세요.");
  if (!token) throw new Error("기기 토큰이 없어요. 설정에서 넣어 주세요.");
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
}

async function serverError(res: Response, doing: string): Promise<string> {
  let body: { error?: string; found?: Record<string, number> } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // JSON 이 아니면 상태 코드로만 본다.
  }
  void logDebug(`서버 ${doing} 실패 ${res.status}: ${body.error ?? ""}`);
  if (res.status === 401) return "기기 토큰이 맞지 않아요. 설정에서 다시 넣어 주세요.";
  if (res.status === 422) {
    // 서버가 무엇을 몇 건 잡았는지만 준다. 값은 오지 않는다.
    const kinds = Object.keys(body.found ?? {}).join(", ");
    return `가려지지 않은 것이 남아 있어요 (${kinds}). 병동 사전에 이름을 넣어 주세요.`;
  }
  if (res.status === 404) return "서버 주소가 맞지 않아요. 설정에서 확인해 주세요.";
  return `서버가 ${doing}에 실패했어요 (${res.status}). 잠시 뒤 다시 해 주세요.`;
}

/** 서버가 살아 있는지만 본다. 토큰이 없어도 된다. */
export async function checkServer(): Promise<{ ok: boolean; message: string }> {
  const url = await getServerUrl();
  if (!url) return { ok: false, message: "서버 주소를 먼저 넣어 주세요." };
  try {
    const res = await fetch(`${url}/healthz`);
    if (!res.ok) return { ok: false, message: `서버가 ${res.status} 를 줬어요. 주소를 확인해 주세요.` };
    if (!(await getDeviceToken())) {
      return { ok: false, message: "서버는 살아 있어요. 이제 기기 토큰을 넣어 주세요." };
    }
    // 토큰까지 맞는지는 실제로 한 번 물어봐야 안다.
    const pull = await call("/pull");
    if (pull.status === 401) {
      return { ok: false, message: "토큰이 맞지 않아요. 서버의 값을 그대로 넣어 주세요." };
    }
    return { ok: true, message: "연결됐어요. 이제 근무를 보낼 수 있어요." };
  } catch {
    return { ok: false, message: "서버에 닿지 못했어요. 주소와 인터넷을 확인해 주세요." };
  }
}

/**
 * 근무 하나를 올린다.
 *
 * 문장마다 가리기를 통과시킨다. 8시간 근무는 문장이 수천 개라 한 번에 돌리면
 * 화면이 멎는다 — 덩어리로 나눠 숨 쉴 틈을 준다 (전사 교정과 같은 이유).
 */
export async function sendShift(
  shiftId: string,
  onProgress?: (pct: number, note?: string) => void,
): Promise<{ sentences: number; redacted: number }> {
  const segments = await listSegments(shiftId);
  if (segments.length === 0) throw new Error("이 근무에는 아직 전사본이 없어요.");

  onProgress?.(5, "개인정보 가리는 중");
  const out: { t: number; speaker?: string; text: string }[] = [];
  let redacted = 0;
  const CHUNK = 40;
  for (let i = 0; i < segments.length; i++) {
    if (i % CHUNK === 0) {
      onProgress?.(5 + Math.round((i / segments.length) * 55), `가리는 중 — ${i}/${segments.length} 문장`);
      await new Promise((r) => setTimeout(r, 0));
    }
    const seg = segments[i];
    const red = await redactForNetwork(seg.text);
    redacted += red.result.redactions.length;
    if (red.text.trim()) {
      out.push({
        t: Math.round(seg.startSec * 10) / 10,
        // 화자는 기계 이름표만 보낸다. 사람 이름을 붙여 뒀어도 나가지 않는다.
        speaker: seg.speakerId,
        text: red.text,
      });
    }
  }

  const [date, code] = shiftId.split(":");
  const taeum = await getTaeumScore(shiftId);
  const terms = (await listUserTerms()).slice(0, 500).map((t) => ({
    entry: t.ko,
    meaning: t.en || t.abbr || t.ko,
    note: t.aliases?.join(", ") || undefined,
  }));

  onProgress?.(70, "서버로 보내는 중");
  const res = await call("/ingest", {
    method: "POST",
    body: JSON.stringify({
      shiftId,
      date,
      code,
      minutes: Math.round((segments.at(-1)?.endSec ?? 0) / 60),
      masked: true,
      taeum: taeum ? { score: taeum.score, level: taeum.level } : undefined,
      terms,
      sentences: out,
    }),
  });
  if (!res.ok) throw new Error(await serverError(res, "근무 보내기"));
  onProgress?.(100, "보냈어요");
  return { sentences: out.length, redacted };
}

/**
 * 서버에 쌓인 결과를 받아온다 — AI 가 쓴 보고서와 새 병동 용어.
 * 받은 것은 알려 줘서 다음에 또 오지 않게 한다.
 */
export async function pullFromServer(): Promise<{ reports: number; terms: number }> {
  const res = await call("/pull");
  if (!res.ok) throw new Error(await serverError(res, "결과 받기"));
  const body = (await res.json()) as {
    reports?: { shiftId: string; markdown: string }[];
    terms?: { entry: string; meaning: string; note?: string | null }[];
  };

  const reports = body.reports ?? [];
  const terms = body.terms ?? [];
  for (const r of reports) {
    await saveShiftReport(r.shiftId, r.markdown, { source: "server" });
  }
  for (const t of terms) {
    const ko = (t.entry ?? "").trim();
    if (ko.length < 2) continue;
    await saveUserTerm({
      // 같은 말을 여러 번 받아도 한 줄만 남게 id 를 말에서 만든다.
      id: `srv-${ko}`,
      ko,
      aliases: [],
      category: "workflow",
      definition:
        [t.meaning?.trim(), t.note?.trim()].filter(Boolean).join(" · ") ||
        "AI 가 넣은 말이에요. 뜻을 고쳐 주세요.",
    });
  }

  if (reports.length || terms.length) {
    await call("/pulled", {
      method: "POST",
      body: JSON.stringify({
        shiftIds: reports.map((r) => r.shiftId),
        entries: terms.map((t) => t.entry),
      }),
    });
  }
  return { reports: reports.length, terms: terms.length };
}
