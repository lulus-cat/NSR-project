import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * 오디오 파일 → 16kHz 모노 WAV (whisper.cpp 입력 형식).
 *
 * 안드로이드에서만 구현되어 있다. iOS 는 아직 없다 — 그쪽에서 부르면
 * available 이 false 이므로 화면은 서버 전사를 안내해야 한다.
 */
const Native = requireOptionalNativeModule<{
  decodeToWav16k(srcPath: string, dstPath: string): Promise<string>;
}>("NsrAudioDecode");

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
