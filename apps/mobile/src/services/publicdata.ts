/**
 * 공공데이터포털(data.go.kr) 연동 — 키 하나로 두 가지를 얻는다.
 *
 *   1. 심평원 병원정보서비스 — 전국 병원 이름·주소·좌표. 근무지 검색이
 *      OSM 과 비교가 안 되게 정확하다 (건강보험 청구기관 전수).
 *   2. 식약처 e약은요 — 약 이름으로 효능·용법·주의사항. 투약 공부용.
 *
 * 키는 무료다: data.go.kr 가입 → 각 서비스 "활용신청" → 마이페이지의
 * **일반 인증키(Decoding)** 를 앱에 붙여넣는다. 키는 이 기기의 보안
 * 저장소에만 있고, 요청은 정부 서버로 직접 간다.
 */

export const PUBLIC_DATA_KEY_SETTING = "publicdata.serviceKey";

import { getSetting, setSetting } from "../db";
import { BUILT_IN } from "../config";

/**
 * 저장소의 app-config.json 에서 공유 키를 받아온다.
 *
 * 사용자마다 키를 발급받게 하면 아무도 안 쓴다. 개발자가 자기 키를
 * 이 파일에 넣어 두면 전 설치자가 나눠 쓴다 — 공개 저장소라 키도
 * 공개되지만, 무료 공공데이터 키라 잃을 것이 트래픽 한도뿐이다.
 * 하루 한 번만 확인하고 캐시한다.
 */
const SHARED_CONFIG_URL =
  "https://raw.githubusercontent.com/lulus-cat/NSR-project/main/app-config.json";

interface SharedConfig {
  publicDataKey?: string;
  kakaoKey?: string;
}

async function getSharedConfig(): Promise<SharedConfig> {
  const cached = await getSetting<{ cfg: SharedConfig; at: number } | null>(
    "publicdata.sharedCfg",
    null,
  );
  if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.cfg;
  try {
    const res = await fetch(SHARED_CONFIG_URL);
    if (!res.ok) return cached?.cfg ?? {};
    const cfg = (await res.json()) as SharedConfig;
    const clean: SharedConfig = {
      publicDataKey: (cfg.publicDataKey ?? "").trim() || undefined,
      kakaoKey: (cfg.kakaoKey ?? "").trim() || undefined,
    };
    await setSetting("publicdata.sharedCfg", { cfg: clean, at: Date.now() });
    return clean;
  } catch {
    return cached?.cfg ?? {};
  }
}

async function getKey(): Promise<string | null> {
  // 내 키 > 빌드 내장 키 > 저장소 공유 키. 보통 사용자는 아무것도 안 넣는다.
  const SecureStore = await import("expo-secure-store");
  const own = await SecureStore.getItemAsync("publicdata.serviceKey");
  if (own) return own;
  if (BUILT_IN.publicDataKey) return BUILT_IN.publicDataKey;
  return (await getSharedConfig()).publicDataKey ?? null;
}

export async function setPublicDataKey(key: string | null): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  if (key) {
    await SecureStore.setItemAsync("publicdata.serviceKey", key.trim(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync("publicdata.serviceKey");
  }
}

export async function hasPublicDataKey(): Promise<boolean> {
  return (await getKey()) !== null;
}

/* ── 카카오 로컬 검색 ─────────────────────────────────────────────
 * 병원 이름 검색은 카카오가 제일 잘 안다 (지도 앱과 같은 데이터).
 * developers.kakao.com → 내 애플리케이션 → REST API 키. 무료·카드 등록 없음.
 * 내 키가 우선, 없으면 저장소 공유 키. */

const KAKAO_KEY_SECURE = "kakao.restKey";

export async function setKakaoKey(key: string | null): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  if (key) {
    await SecureStore.setItemAsync(KAKAO_KEY_SECURE, key.trim(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(KAKAO_KEY_SECURE);
  }
}

async function getKakaoKey(): Promise<string | null> {
  const SecureStore = await import("expo-secure-store");
  const own = await SecureStore.getItemAsync(KAKAO_KEY_SECURE);
  if (own) return own;
  if (BUILT_IN.kakaoKey) return BUILT_IN.kakaoKey;
  return (await getSharedConfig()).kakaoKey ?? null;
}

export async function hasKakaoKey(): Promise<boolean> {
  return (await getKakaoKey()) !== null;
}

export interface KakaoPlace {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

/**
 * 카카오 키워드 장소 검색. 키가 없으면 null (호출 쪽이 심평원으로 넘어간다).
 * category_group_code=HP8 로 **병원만** 나온다 — 근무지 검색에 카페가 섞이면 안 된다.
 */
export async function searchPlacesKakao(query: string): Promise<KakaoPlace[] | null> {
  const key = await getKakaoKey();
  if (!key) return null;
  const res = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?size=8&category_group_code=HP8&query=${encodeURIComponent(query.trim())}`,
    { headers: { Authorization: `KakaoAK ${key}` } },
  );
  if (res.status === 401) throw new Error("카카오 REST 키가 올바르지 않습니다. 설정에서 다시 확인하십시오.");
  if (!res.ok) throw new Error(`카카오 검색 실패 (${res.status})`);
  const data = (await res.json()) as {
    documents?: { place_name?: string; address_name?: string; road_address_name?: string; x?: string; y?: string }[];
  };
  return (data.documents ?? [])
    .filter((d) => d.x && d.y)
    .map((d) => ({
      name: String(d.place_name ?? ""),
      address: String(d.road_address_name || d.address_name || ""),
      latitude: Number(d.y),
      longitude: Number(d.x),
    }))
    .filter((p) => p.name && Number.isFinite(p.latitude));
}

/** items.item 이 하나면 객체, 여럿이면 배열로 온다 — 공공데이터의 오래된 버릇. */
function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

export interface HospitalHit {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

/** 심평원 병원 검색. 키가 없으면 null (호출 쪽이 OSM 으로 넘어간다). */
export async function searchHospitalsHira(query: string): Promise<HospitalHit[] | null> {
  const key = await getKey();
  if (!key) return null;
  const url =
    "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList" +
    `?serviceKey=${encodeURIComponent(key)}&yadmNm=${encodeURIComponent(query.trim())}` +
    "&numOfRows=8&pageNo=1&_type=json";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`병원 검색 실패 (${res.status})`);
  const data = (await res.json()) as {
    response?: {
      header?: { resultCode?: string; resultMsg?: string };
      body?: { items?: { item?: unknown } };
    };
  };
  const header = data.response?.header;
  if (header?.resultCode && header.resultCode !== "00") {
    // 키 오류(등록 안 됨·미승인)는 여기로 온다. 원문을 그대로 보여준다.
    throw new Error(`공공데이터 응답: ${header.resultMsg ?? header.resultCode}`);
  }
  return asArray(data.response?.body?.items?.item as Record<string, unknown>[] | undefined)
    .filter((i) => i.XPos && i.YPos)
    .map((i) => ({
      name: String(i.yadmNm ?? ""),
      address: String(i.addr ?? ""),
      latitude: Number(i.YPos),
      longitude: Number(i.XPos),
    }))
    .filter((h) => h.name && Number.isFinite(h.latitude));
}

export interface DrugInfo {
  name: string;
  company: string;
  /** 효능. */
  effect: string;
  /** 용법·용량. */
  usage: string;
  /** 주의사항. */
  caution: string;
}

const strip = (s: unknown): string =>
  String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** 식약처 e약은요 — 약 이름으로 안전 정보. 키가 없으면 null. */
export async function searchDrug(name: string): Promise<DrugInfo[] | null> {
  const key = await getKey();
  if (!key) return null;
  const url =
    "https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList" +
    `?serviceKey=${encodeURIComponent(key)}&itemName=${encodeURIComponent(name.trim())}` +
    "&numOfRows=5&pageNo=1&type=json";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`의약품 검색 실패 (${res.status})`);
  const data = (await res.json()) as { body?: { items?: unknown } };
  return asArray(data.body?.items as Record<string, unknown>[] | undefined).map((i) => ({
    name: strip(i.itemName),
    company: strip(i.entpName),
    effect: strip(i.efcyQesitm),
    usage: strip(i.useMethodQesitm),
    caution: strip(i.atpnQesitm),
  }));
}
