/**
 * 클로바 스피치 전사 — 네이버클라우드 CLOVA Speech 장문 인식.
 *
 * 이 앱이 처음으로 여는 **상용 API** 전사 경로다. 원칙(기본은 온디바이스)을
 * 바꾼 것이 아니라 예외를 하나 둔 것이다 — 사용자가 실사용 비교에서
 * 클로바노트의 품질을 가장 높게 봤고, 무엇보다 이 경로만 **화자 분리**가
 * 자동으로 된다. 기기 안 Whisper 는 목소리를 구별하지 못한다.
 *
 * 정직하게: 기록 음성 **원본**이 네이버클라우드 서버로 올라간다. 오디오는
 * 전송 전에 비식별화할 방법이 없다(음성 안에 이름·진단이 그대로 있다).
 * 그래서 이 경로는 키를 직접 넣어 명시적으로 켠 사용자에게만 열리고,
 * 화면에 무엇이 나가는지 적혀 있다.
 *
 * API 형식: POST {Invoke URL}/recognizer/upload, X-CLOVASPEECH-API-KEY 헤더,
 * multipart(media 파일 + params JSON 문자열). completion:"sync" 로 부르면
 * 응답이 곧 결과다. segments 의 start/end 는 밀리초.
 * Secret Key 는 유료 키 규칙대로 기기 SecureStore 에만 산다.
 */

import { getSetting, setSetting } from "../db";
import type { AsrProvider } from "./asr";

export interface ClovaSettings {
  enabled: boolean;
  /** 콘솔의 도메인 상세에 있는 Invoke URL. 계정마다 다르다. */
  invokeUrl: string;
}

const SETTING = "asr.clova";
const SECURE_KEY = "clova.secretKey";

export async function loadClovaSettings(): Promise<ClovaSettings> {
  return getSetting<ClovaSettings>(SETTING, { enabled: false, invokeUrl: "" });
}

export async function saveClovaSettings(next: ClovaSettings): Promise<void> {
  await setSetting(SETTING, next);
}

export async function getClovaSecret(): Promise<string | null> {
  try {
    const SecureStore = await import("expo-secure-store");
    return await SecureStore.getItemAsync(SECURE_KEY);
  } catch {
    return null;
  }
}

export async function setClovaSecret(key: string): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  if (key) {
    await SecureStore.setItemAsync(SECURE_KEY, key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(SECURE_KEY);
  }
}

interface ClovaSegment {
  start: number;
  end: number;
  text: string;
  speaker?: { label?: string; name?: string };
  confidence?: number;
}

export function createClovaProvider(invokeUrl: string, secretKey: string): AsrProvider {
  const base = invokeUrl.trim().replace(/\/+$/, "");
  const url = /\/recognizer\/upload$/.test(base) ? base : `${base}/recognizer/upload`;
  return {
    id: "clova-speech",
    kind: "cloud",
    capabilities: { diarization: true, wordTimestamps: true },
    async transcribe(fileUri, _options) {
      // 병동 사전 부스팅(boostings)은 실호출로 형식을 확인한 뒤 붙인다.
      // 첫 판은 모르는 매개변수로 전체 호출이 죽는 위험을 지지 않는다.
      const params = {
        language: "ko-KR",
        completion: "sync",
        fullText: true,
        wordAlignment: true,
        diarization: { enable: true },
      };
      const form = new FormData();
      form.append("media", {
        uri: fileUri,
        name: "audio.m4a",
        type: "audio/m4a",
      } as unknown as Blob);
      form.append("params", JSON.stringify(params));

      const response = await fetch(url, {
        method: "POST",
        headers: { "X-CLOVASPEECH-API-KEY": secretKey, Accept: "application/json" },
        body: form,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        throw new Error(
          response.status === 401 || response.status === 403
            ? "클로바 인증에 실패했습니다. Secret Key 와 Invoke URL 을 확인하십시오."
            : `클로바 전사 오류 ${response.status}: ${body}`,
        );
      }
      const json = (await response.json()) as {
        result?: string;
        message?: string;
        text?: string;
        segments?: ClovaSegment[];
      };
      // HTTP 200 이어도 result 가 COMPLETED 가 아니면 실패다(형식 오류, 한도 초과 등).
      if (json.result && json.result !== "COMPLETED") {
        throw new Error(`클로바 전사 실패: ${json.message ?? json.result}`);
      }

      const segments = (json.segments ?? []).map((s) => ({
        startSec: s.start / 1000,
        endSec: s.end / 1000,
        text: (s.text ?? "").trim(),
        // name("A","B")이 화면 표시용으로 낫고, 없으면 label("1","2")로.
        speakerId: s.speaker?.name || s.speaker?.label || undefined,
        confidence: s.confidence,
      }));
      if (segments.length === 0 && json.text?.trim()) {
        segments.push({
          startSec: 0,
          endSec: 0,
          text: json.text.trim(),
          speakerId: undefined,
          confidence: undefined,
        });
      }
      const durationSec = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
      return { segments, durationSec };
    },
  };
}
