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
  const source = new File(sourceUri);
  try {
    if (!source.exists) return sourceUri;
    const destination = new File(recordingsDirectory(), fileName);
    if (destination.exists) destination.delete();
    source.moveSync(destination); // 이동 후 source.uri 는 새 위치를 가리킨다.
    return source.uri;
  } catch {
    // 이동이 실패하면 복사로라도 문서 디렉터리에 넣는다. 캐시 경로를 DB 에
    // 남기면 OS 가 캐시를 비운 며칠 뒤 "파일 없음"으로 죽는다 — 실제로 겪었다.
    try {
      const destination = new File(recordingsDirectory(), fileName);
      if (destination.exists) destination.delete();
      source.copySync(destination);
      try {
        source.delete();
      } catch {
        // 원본 캐시 파일은 OS 가 알아서 지운다.
      }
      return destination.uri;
    } catch {
      return sourceUri; // 마지막 수단 — 적어도 이번 세션에는 남아 있다.
    }
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

/**
 * 녹음 폴더에 있는데 DB 가 모르는 파일 목록.
 *
 * 이런 파일이 생기는 길이 여럿이다 — 저장이 되감겼을 때, DB 를 못 열었을 때,
 * 조각을 여는 중에 앱이 죽었을 때. 지금까지는 그 소리가 폴더에 남아 있어도
 * 앱이 볼 방법이 없었고, 용량 계산에도 안 잡히고, 영영 지워지지도 않았다.
 *
 * 파일 이름이 `근무id__번호.m4a` 라서 어느 근무의 것인지 되살릴 수 있다.
 */
export function orphanRecordings(known: string[]): { uri: string; shiftId: string; seq: number }[] {
  const dir = recordingsDirectory();
  const owned = new Set(known.map((u) => u.split("/").pop()));
  const out: { uri: string; shiftId: string; seq: number }[] = [];
  try {
    for (const name of dir.list().map((f) => f.name ?? "")) {
      if (!name.endsWith(".m4a") && !name.endsWith(".wav")) continue;
      if (owned.has(name)) continue;
      const m = /^(.+)__(\d+)\.(m4a|wav)$/.exec(name);
      if (!m) continue;
      out.push({
        uri: recordingFileUri(name),
        shiftId: m[1].replace(/_/g, ":"),
        seq: Number(m[2]),
      });
    }
  } catch {
    // 폴더를 못 읽으면 되찾을 것도 없다.
  }
  return out;
}
