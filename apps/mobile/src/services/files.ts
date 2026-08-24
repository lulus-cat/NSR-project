/**
 * 파일 접근 래퍼.
 *
 * expo-file-system은 SDK 54에서 API가 통째로 바뀌었다.
 * 예전 `getInfoAsync` / `deleteAsync` / `documentDirectory`는 타입만 남아 있고
 * **런타임에는 던진다**. 타입체크를 통과해도 기기에서 죽는다는 뜻이라
 * 한 군데로 모아 새 API(`File` / `Directory` / `Paths`)만 쓰도록 한다.
 */

import { Directory, File, Paths } from "expo-file-system";

const RECORDINGS_DIR = "recordings";

/** 녹음 폴더. 없으면 만든다. */
export function recordingsDirectory(): Directory {
  const dir = new Directory(Paths.document, RECORDINGS_DIR);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

export function recordingFileUri(fileName: string): string {
  return new File(recordingsDirectory(), fileName).uri;
}

/**
 * 녹음이 끝난 임시 파일을 녹음 폴더로 옮긴다.
 *
 * expo-audio는 자기 캐시 경로에 쓰고 `uri`로 알려줄 뿐, 출력 경로를 지정할 수 없다.
 * 캐시는 OS가 언제든 비울 수 있으므로 반드시 문서 디렉터리로 옮겨야 한다.
 *
 * @returns 옮긴 뒤의 URI. 실패하면 원래 URI(적어도 이번 세션에는 남아 있다).
 */
export function moveIntoRecordings(sourceUri: string, fileName: string): string {
  try {
    const source = new File(sourceUri);
    if (!source.exists) return sourceUri;
    const destination = new File(recordingsDirectory(), fileName);
    if (destination.exists) destination.delete();
    source.moveSync(destination);
    return source.uri;
  } catch {
    return sourceUri;
  }
}

/** 파일 크기(바이트). 없으면 0. */
export function fileSize(uri: string): number {
  try {
    const file = new File(uri);
    return file.exists ? file.size : 0;
  } catch {
    return 0;
  }
}

/** 파일 삭제. 이미 없으면 조용히 넘어간다. */
export function deleteFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // 지우려던 파일이 없는 것은 실패가 아니다.
  }
}

/** 녹음 폴더 전체 삭제. 데이터 초기화에서 쓴다. */
export function deleteAllRecordings(): void {
  try {
    const dir = new Directory(Paths.document, RECORDINGS_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // 폴더가 없으면 지울 것도 없다.
  }
}

/** 기기 여유 공간(바이트). 녹음 시작 전 확인용. */
export function availableDiskBytes(): number {
  return Paths.availableDiskSpace;
}
