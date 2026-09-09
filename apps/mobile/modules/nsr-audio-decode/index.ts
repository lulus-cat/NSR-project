import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * 오디오 파일 → 16kHz 모노 WAV (whisper.cpp 입력 형식).
 *
 * 안드로이드에서만 구현되어 있다. iOS 는 아직 없다 — 그쪽에서 부르면
 * available 이 false 이므로 화면은 서버 전사를 안내해야 한다.
 */
const Native = requireOptionalNativeModule<{
  decodeToWav16k(srcPath: string, dstPath: string): Promise<string>;
  audioDurationSec(srcPath: string): Promise<number>;
  splitAudio(srcPath: string, dstDir: string, chunkSec: number): Promise<AudioPart[]>;
  workStart(title: string, body: string, mic: boolean): void;
  workUpdate(title: string, body: string): void;
  workNeedsMic(): void;
  workStop(): void;
  workAlive(): boolean;
}>("NsrAudioDecode");

/**
 * 나눈 조각 하나. startSec 은 원본 안에서 이 조각이 시작하는 시각이다.
 *
 * 지금은 부르는 곳이 없다. 티로에 파일을 올려 전사하던 길에서만 썼는데(3시간씩
 * 나눠 올렸다), 티로가 그 API 를 이 계정에 안 열어 줘서 앱에서 지웠다.
 * 네이티브 쪽은 남겨 둔다 — 티로가 열어 주거나 다른 업로드 경로가 생기면 그대로 쓴다.
 */
export interface AudioPart {
  /** file:// 를 붙인 경로 — 그대로 업로드에 쓴다. */
  uri: string;
  startSec: number;
  durationSec: number;
}

export function audioDecodeAvailable(): boolean {
  return Native != null;
}

const stripScheme = (p: string) => p.replace(/^file:\/\//, "");

/** 변환해서 dstPath 에 쓴다. 돌려주는 값은 완성된 파일 경로. */
export async function decodeToWav16k(srcUri: string, dstUri: string): Promise<string> {
  if (!Native) {
    throw new Error(
      "이 기기에서는 기기 내 오디오 변환을 지원하지 않습니다. 설정에서 노트북·서버 전사를 사용하십시오.",
    );
  }
  return Native.decodeToWav16k(stripScheme(srcUri), stripScheme(dstUri));
}

/**
 * 작업 유지 — 포그라운드 서비스를 잡아 다른 앱으로 넘어가도
 * 다운로드·전사가 얼리지 않게 한다 (Android 전용, 없으면 조용히 무시).
 * 알림 제목/본문이 곧 진행 표시다.
 */
/**
 * 포그라운드 서비스를 잡는다.
 *
 * `mic` 를 켜면 microphone 유형까지 잡는다 — **녹음 중에는 반드시 켜야 한다.**
 * 안드로이드 14+ 는 화면이 꺼진 뒤의 마이크 접근을 이 유형으로만 허용한다.
 * 녹음이 아닌 작업(내려받기)에 켜면 RECORD_AUDIO 가 없을 때 서비스가 죽는다.
 */
export type WorkStart = "started" | "failed" | "unavailable";

/**
 * "failed" 는 안드로이드가 **지금은 안 된다** 고 한 것이다 — 12 부터는 앱이
 * 뒤에 있을 때 포그라운드 서비스를 못 연다(ForegroundServiceStartNotAllowed).
 * "unavailable" 은 이 환경에 서비스가 없는 것(아이폰·시뮬레이터)이라 정상이다.
 * 둘을 같은 false 로 뭉개면 녹음 쪽이 "서비스 없이 마이크를 켠 채" 화면이
 * 꺼지는 순간 마이크를 잃는다.
 */
export function workStart(title: string, body: string, mic = false): WorkStart {
  if (!Native?.workStart) return "unavailable";
  try {
    Native.workStart(title, body, mic);
    return "started";
  } catch {
    return "failed";
  }
}

/** 이미 떠 있는 서비스에 마이크 유형을 뒤늦게 붙인다 (녹음이 나중에 시작될 때). */
export function workNeedsMic(): void {
  try {
    Native?.workNeedsMic?.();
  } catch {
    // 없는 환경이면 그만이다.
  }
}

export function workUpdate(title: string, body: string): void {
  try {
    Native?.workUpdate?.(title, body);
  } catch {
    // 서비스가 없으면 그만이다.
  }
}

/** 서비스가 지금 떠 있는가. 없는 환경(아이폰)은 null — 모른다는 뜻이다. */
export function workAlive(): boolean | null {
  if (!Native?.workAlive) return null;
  try {
    return Native.workAlive();
  } catch {
    return null;
  }
}

export function workStop(): void {
  try {
    Native?.workStop?.();
  } catch {
    // 위와 같다.
  }
}

/** 파일 길이(초). 모르면 0 — 네이티브 모듈이 없거나 길이가 안 적힌 파일. */
export async function audioDurationSec(srcUri: string): Promise<number> {
  if (!Native?.audioDurationSec) return 0;
  try {
    return await Native.audioDurationSec(stripScheme(srcUri));
  } catch {
    return 0;
  }
}

/**
 * 긴 녹음을 chunkSec 초씩 나눈다. 다시 인코딩하지 않고 컨테이너만 새로 쓴다.
 *
 * 빈 배열은 **안 나눠도 된다**는 뜻이다 — 파일이 짧거나, 담을 수 없는 코덱(mp3 등)
 * 이거나, 이 기기에 모듈이 없을 때. 부르는 쪽은 원본을 그대로 쓰면 된다.
 */
export async function splitAudio(
  srcUri: string,
  dstDir: string,
  chunkSec: number,
): Promise<AudioPart[]> {
  if (!Native?.splitAudio) return [];
  const parts = (await Native.splitAudio(
    stripScheme(srcUri),
    stripScheme(dstDir),
    chunkSec,
  )) as unknown as { path: string; startSec: number; durationSec: number }[];
  return parts.map((p) => ({
    uri: p.path.startsWith("file://") ? p.path : `file://${p.path}`,
    startSec: p.startSec,
    durationSec: p.durationSec,
  }));
}
