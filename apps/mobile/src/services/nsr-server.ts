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
 * 열쇠는 사람이 안 만진다
 * ----------------------
 * 주소를 넣고 「잇기」 를 누르는 것이 전부다. 터미널도 QR 도 없다.
 *
 *   - 서버에 이어진 기기가 **하나도 없으면** 그대로 이어진다 (처음 한 번만
 *     열리는 문). Jellyfin·Home Assistant 의 첫 실행과 같은 방식이다.
 *   - 이미 기기가 있으면 여섯 자리 번호가 뜨고, **이미 이어진 폰**에서 승인해야
 *     열쇠가 나온다 (Syncthing·시그널의 기기 연결과 같은 방식이다).
 *   - 앱을 지웠다 다시 깔면 열쇠가 사라진다. 그때 승인해 줄 기기도 없으면
 *     **복구 번호**로 잇는다. 처음 이을 때 서버가 만들어 주고, 이어진 앱은
 *     설정에서 언제든 볼 수 있다. 한 번 쓰면 새 번호로 바뀐다.
 *
 * 401 이 오면 이 폰의 열쇠를 **지운다**. 서버가 모르는 열쇠를 들고 있어 봐야
 * 계속 막히기만 하고, 화면에는 '연결됨'으로 보여서 사람이 더 헷갈린다.
 * (서버 DB 를 갈아 끼웠을 때 실제로 이렇게 된다.)
 */
import * as SecureStore from "expo-secure-store";
import {
  getSetting,
  getTaeumScore,
  listSegmentsAbsolute,
  listUserTerms,
  saveShiftReport,
  saveUserTerm,
  setSetting,
} from "../db";
import { redactForNetwork } from "./export";
import { deidentify } from "@nsr/core";
import { logDebug } from "./debug";

const URL_KEY = "nsr.server.url";
const TOKEN_KEY = "nsr.server.deviceToken";
/** 연달아 몇 번 401 이 났나. 두 번이면 열쇠를 버린다. */
const UNAUTH_KEY = "nsr.server.unauthorizedCount";

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
  // https:// 도 여기서 붙인다 — 사람은 주소창에 그걸 안 치는 것이 보통이고,
  // 없으면 fetch 가 영어 오류를 던져서 화면에 그대로 나간다.
  const bare = url.trim().replace(/\/+$/, "");
  await setSetting(URL_KEY, bare && !/^https?:\/\//i.test(bare) ? `https://${bare}` : bare);
}

export async function getDeviceToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setDeviceToken(token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token.trim());
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/** 서버가 준 열쇠를 보관한다. 복구 번호는 사람이 적어 둘 것이라 저장하지 않는다. */
async function keep(body: { token?: string }): Promise<void> {
  if (!body.token) throw new Error("서버가 열쇠를 주지 않았어요. 다시 눌러 주세요.");
  await setDeviceToken(body.token);
  await setSetting(UNAUTH_KEY, 0);
}

/**
 * 서버에 한 번 묻는다.
 *
 * 셋을 여기서 한꺼번에 막는다.
 *  - 그물이 끊기면 fetch 는 영어로 "Network request failed" 를 던진다. 그대로
 *    화면에 나가면 사람이 읽을 수가 없다.
 *  - 안드로이드의 기본 fetch 에는 시간 제한이 아예 없다. 서버가 받기만 하고
 *    대답을 안 하면 버튼이 영원히 도는 중이 된다.
 *  - 프록시가 HTML 오류 쪽지를 200 으로 돌려주면 res.json() 이 터진다.
 */
const ASK_MS = 20_000;

async function ask(path: string, init: RequestInit, timeoutMs = ASK_MS): Promise<Response> {
  const url = await getServerUrl();
  if (!url) throw new Error("서버 주소가 없어요. 설정에서 넣어 주세요.");
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    return await fetch(`${url}${path}`, { ...init, signal: stop.signal });
  } catch {
    throw new Error("서버에 닿지 못했어요. 주소와 인터넷을 확인해 주세요.");
  } finally {
    clearTimeout(timer);
  }
}

async function postPublic(path: string, payload: unknown, timeoutMs = ASK_MS): Promise<Response> {
  return ask(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
    timeoutMs,
  );
}

/** JSON 이 아니어도 안 죽는다. 프록시는 HTML 오류 쪽지를 200 으로도 준다. */
async function readJson<T>(res: Response): Promise<Partial<T>> {
  return (await res.json().catch(() => ({}))) as Partial<T>;
}

/**
 * 404 는 두 가지다 — 주소가 틀렸거나, 서버가 옛 판이라 그 주소가 아직 없거나.
 *
 * 사람에게 "둘 중 하나예요" 라고 하면 할 수 있는 일이 없다. 앱이 가려 준다:
 * 뿌리(`/healthz`)가 대답하면 주소는 맞는 것이고, 없는 것은 새 주소다.
 */
async function notFound(): Promise<string> {
  const url = await getServerUrl();
  try {
    const alive = await fetch(`${url}/healthz`);
    if (alive.ok) return "서버가 옛 판이에요. 서버를 올려 주세요.";
  } catch {
    // 뿌리조차 안 되면 주소 쪽이다.
  }
  return "서버 주소가 맞지 않아요. 설정에서 확인해 주세요.";
}

/**
 * 실패한 대답을 사람 말로 바꾼다.
 *
 * 서버가 보낸 문장을 그대로 쓰지 않는다 — 서버 문구는 '…해 주십시오' 이고
 * 'JSON' 같은 말이 섞여 있다. 화면 문구는 해요체다 (`nsr-design` 스킬).
 */
async function why(res: Response, fallback: string): Promise<string> {
  const body = await readJson<{ error?: string }>(res);
  void logDebug(`서버 ${res.status}: ${body.error ?? ""}`);
  if (res.status === 401) return "이 폰이 서버에 안 이어져 있어요. 다시 이어 주세요.";
  if (res.status === 404) return await notFound();
  if (res.status === 429) return "지금은 이을 수 없어요. 10분 뒤에 해 주세요.";
  if (res.status >= 500) return "서버가 대답하지 못했어요. 잠시 뒤 다시 해 주세요.";
  return fallback;
}

/**
 * 잇기를 시작한다.
 *
 * 서버에 기기가 하나도 없으면 여기서 끝난다(`{ linked: true }`). 이미 있으면
 * 여섯 자리 번호를 받아 오고, 그 번호를 이미 이어진 폰이 승인할 때까지
 * `pollLink` 로 기다린다.
 */
export interface LinkTicket {
  linked: boolean;
  /** 사람이 옮겨 적는 여섯 자리 */
  code?: string;
  /** 이 기기만 아는 쪽지. 번호를 남이 맞혀도 열쇠는 못 가져간다 */
  poll?: string;
  recovery?: string;
}

export async function linkDevice(): Promise<LinkTicket> {
  const res = await postPublic("/device/link", {});
  if (res.status === 202) {
    const { code, poll } = await readJson<{ code: string; poll: string }>(res);
    if (!code || !poll) throw new Error("서버가 번호를 주지 않았어요. 다시 눌러 주세요.");
    return { linked: false, code, poll };
  }
  if (!res.ok) throw new Error(await why(res, "잇지 못했어요. 주소를 확인해 주세요."));
  const body = await readJson<{ token: string; recovery: string }>(res);
  await keep(body);
  return { linked: true, recovery: body.recovery };
}

/** 승인을 기다린다. 아직이면 false, 승인되면 열쇠를 넣고 true. */
export async function pollLink(
  code: string,
  poll: string,
): Promise<{ linked: boolean; recovery?: string }> {
  const res = await postPublic("/device/link/poll", { code, poll });
  if (res.status === 404) return { linked: false };
  if (!res.ok) throw new Error(await why(res, "기다리지 못했어요. 다시 해 주세요."));
  const body = await readJson<{ token: string; recovery: string }>(res);
  await keep(body);
  return { linked: true, recovery: body.recovery };
}

/** 서버가 쓰는 글자만 남긴다 (헷갈리는 0·O·1·I 는 애초에 안 쓴다). */
const RECOVERY_LETTERS = /[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g;

/**
 * 복구 번호로 잇는다. 앱을 지웠다 다시 깔았을 때 쓴다.
 *
 * 길이는 여기서 먼저 본다. 서버는 다섯 번 틀리면 10분 잠그는데, 빈 칸이나
 * 오타로 그 다섯 번을 다 쓰면 정작 맞는 번호를 넣을 때 잠겨 있다.
 */
export async function recoverDevice(recovery: string): Promise<string | undefined> {
  const letters = (recovery.toUpperCase().match(RECOVERY_LETTERS) ?? []).join("");
  if (letters.length !== 12) throw new Error("복구 번호 열두 자리를 넣어 주세요.");
  const res = await postPublic("/device/recover", { recovery: letters });
  if (!res.ok) throw new Error(await why(res, "복구 번호가 맞지 않아요. 다시 넣어 주세요."));
  const body = await readJson<{ token: string; recovery: string }>(res);
  await keep(body);
  return body.recovery;
}

export interface LinkedDevice {
  label?: string | null;
  created_at: number;
  last_seen_at?: number | null;
  /** 지금 이 폰인가. 낯선 줄을 가리려면 이게 있어야 한다 */
  mine?: boolean;
}

export interface ServerState {
  devices: LinkedDevice[];
  recovery: string;
}

/** 이어진 기기 목록과 복구 번호. 낯선 기기가 있으면 여기서 보인다. */
export async function serverState(): Promise<ServerState> {
  const res = await call("/device/state");
  if (!res.ok) throw new Error(await serverError(res, "기기 목록 보기"));
  const body = await readJson<ServerState>(res);
  return { devices: body.devices ?? [], recovery: body.recovery ?? "" };
}

/** 이 폰만 남기고 끊는다. 앱을 여러 번 다시 깔면 죽은 열쇠가 쌓인다. */
export async function forgetOtherDevices(): Promise<number> {
  const res = await call("/device/forget-others", { method: "POST" });
  if (!res.ok) throw new Error(await serverError(res, "다른 기기 끊기"));
  const { removed } = await readJson<{ removed: number }>(res);
  return removed ?? 0;
}

/**
 * 여섯 자리 번호를 승인한다.
 *
 * 두 가지를 다 받는다 — AI 커넥터 화면에 뜬 번호와, 새로 잇는 기기가 띄운 번호.
 * 어느 쪽인지는 서버가 알아서 가른다. **이어진 폰만** 승인할 수 있다.
 */
export async function approveCode(code: string): Promise<"ai" | "device"> {
  const digits = code.replace(/\D/g, "");
  if (digits.length !== 6) throw new Error("번호 여섯 자리를 넣어 주세요.");
  const res = await call("/connector/approve", {
    method: "POST",
    body: JSON.stringify({ code: digits }),
  });
  if (!res.ok) throw new Error(await serverError(res, "승인"));
  const { kind } = await readJson<{ kind: "ai" | "device" }>(res);
  return kind ?? "ai";
}

export async function serverReady(): Promise<boolean> {
  return !!(await getServerUrl()) && !!(await getDeviceToken());
}

async function call(path: string, init: RequestInit = {}, timeoutMs = ASK_MS): Promise<Response> {
  const token = await getDeviceToken();
  if (!token) throw new Error("이 폰이 아직 서버에 안 이어졌어요. 설정에서 이어 주세요.");
  return ask(
    path,
    {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    },
    timeoutMs,
  );
}

async function serverError(res: Response, doing: string): Promise<string> {
  let body: { error?: string; found?: Record<string, number> } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // JSON 이 아니면 상태 코드로만 본다.
  }
  void logDebug(`서버 ${doing} 실패 ${res.status}: ${body.error ?? ""}`);
  if (res.status === 401) {
    // 서버가 이 폰의 열쇠를 모른다. 다만 **한 번으로 지우지 않는다** — 배포 중이거나
    // 프록시가 끼어들어도 401 은 나오고, 그때 지우면 다시 이어야 한다.
    // 연달아 두 번이면 진짜다.
    const before = (await getSetting<number>(UNAUTH_KEY, 0)) + 1;
    await setSetting(UNAUTH_KEY, before);
    if (before >= 2) {
      await setDeviceToken(null);
      await setSetting(UNAUTH_KEY, 0);
    }
    return "이 폰이 서버에 안 이어져 있어요. 설정에서 다시 이어 주세요.";
  }
  await setSetting(UNAUTH_KEY, 0);
  if (res.status === 422) {
    // 서버가 무엇을 몇 건 잡았는지만 준다. 값은 오지 않는다.
    const kinds = Object.keys(body.found ?? {}).join(", ");
    return `가려지지 않은 것이 남아 있어요 (${kinds}). 병동 사전에 이름을 넣어 주세요.`;
  }
  if (res.status === 404) return await notFound();
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
      return { ok: false, message: "서버는 살아 있어요. 이제 잇기를 눌러 주세요." };
    }
    // 토큰까지 맞는지는 실제로 한 번 물어봐야 안다.
    const pull = await call("/pull");
    if (pull.status === 401) {
      // 여기까지 왔다는 것은 /healthz 가 200 이었다는 뜻이다 — 서버는 멀쩡한데
      // 열쇠만 안 맞는다. 그러면 미루지 않고 지운다.
      await setDeviceToken(null);
      await setSetting(UNAUTH_KEY, 0);
      return { ok: false, message: "이 폰이 서버에 안 이어져 있어요. 다시 이어 주세요." };
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
  // 근무 전체 기준 시각으로 받는다. 파일마다 0 부터 다시 세면 AI 가 보는
  // 시간표가 뒤엉키고, 8시간 근무가 30분으로 보고된다.
  const { segments, minutes } = await listSegmentsAbsolute(shiftId);
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
  // 병동 사전도 사람이 넣은 글이다. 전사본에서 낱말을 눌러 담은 것이 그대로
  // 들어오므로 이름이 섞일 수 있다 — 문장과 똑같이 검사해서 걸리는 것은 뺀다.
  // (문장은 가려서 보내지만 사전은 가려 봐야 뜻이 없다. 그래서 버린다.)
  const clean = (v?: string) => !!v && deidentify(v, { disable: [] }).redactions.length === 0;
  const terms = (await listUserTerms())
    .slice(0, 500)
    .map((t) => ({
      entry: t.ko,
      meaning: t.en || t.abbr || t.ko,
      note: t.aliases?.join(", ") || undefined,
    }))
    .filter((t) => clean(t.entry) && clean(t.meaning) && (!t.note || clean(t.note)));

  onProgress?.(70, "서버로 보내는 중");
  const res = await call(
    "/ingest",
    {
      method: "POST",
      body: JSON.stringify({
      shiftId,
      date,
      code,
      minutes: minutes || Math.round((segments.at(-1)?.endSec ?? 0) / 60),
      masked: true,
      taeum: taeum ? { score: taeum.score, level: taeum.level } : undefined,
      terms,
        sentences: out,
      }),
    },
    // 8시간 근무는 문장이 수천 개다. 다른 요청과 같은 잣대로 끊으면 못 올린다.
    120_000,
  );
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
    // payload 에 마크다운을 함께 남긴다. `{source:"server"}` 만 넣던 것이
    // 로컬 분석 결과를 지웠고, 임상 모드의 '카드 추가' 는 payload 안에서
    // 근거 id 를 찾기 때문에 그 뒤로 아무것도 못 넣었다.
    await saveShiftReport(r.shiftId, r.markdown, { source: "server", markdown: r.markdown });
  }
  const mine = new Set((await listUserTerms()).map((u) => u.ko));
  for (const t of terms) {
    const ko = (t.entry ?? "").trim();
    if (ko.length < 2) continue;
    // 이미 있는 말이면 그대로 둔다. 덮어쓰면 사용자가 고쳐 둔 뜻이 날아간다.
    if (mine.has(ko)) continue;
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
    const told = await call("/pulled", {
      method: "POST",
      body: JSON.stringify({
        shiftIds: reports.map((r) => r.shiftId),
        entries: terms.map((t) => t.entry),
      }),
    });
    // 실패하면 서버는 아직 '안 가져감' 으로 알고 있어서 다음에 또 준다.
    // 그때 같은 보고서를 다시 덮어쓰지 않게 기록해 둔다.
    if (!told.ok) void logDebug("받았다고 알리지 못했어요 — 다음에 다시 받습니다.");
  }
  return { reports: reports.length, terms: terms.length };
}
