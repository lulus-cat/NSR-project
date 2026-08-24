/**
 * 병동 사전 주고받기.
 *
 * 병동 사전은 한 사람이 만들어 여럿이 나눠 쓰는 물건이다. 먼저 들어온 선배가
 * "우리 병동에서 이 말은 이런 뜻이다"를 채워 두면, 신규가 파일 하나 받아서 끝난다.
 * 그 병동을 떠나면 끄면 된다(지우지 않아도 된다 — 다시 돌아올 수도 있으니까).
 *
 * 파일을 주고받는다는 것의 무게
 * ---------------------------
 * 이건 **남이 만든 파일을 내 앱에 넣는 일**이다. 그래서 두 가지를 지킨다.
 *
 *   1. 검증하고 받는다 — `importWardPack`이 항목마다 형태를 보고, 이상한 건 빼고
 *      나머지는 살린다. 사전 하나가 통째로 못 쓰게 되는 일이 없도록.
 *   2. 글자 치환은 자동으로 켜지 않는다 — 사전이 함께 나르는 치환 규칙은
 *      확인 대기 목록에 넣어 둔다. 치환은 전사본의 글자를 그대로 바꾸는 일이라,
 *      악의가 아니라 오타 하나로도 숫자가 바뀔 수 있다.
 */

import { Directory, File, Paths } from "expo-file-system";
import {
  createWardPack,
  exportWardPack,
  importWardPack,
  packStats,
  scanPackForPii,
  describePackFindings,
  type ImportResult,
  type PackPiiFinding,
  type PackStats,
  type WardPack,
} from "@nsr/core";
import {
  addPendingCorrections,
  deleteWardPack,
  enabledWardPacks,
  listWardPacks,
  saveWardPack,
  setWardPackEnabled,
  type StoredPack,
} from "../db";

export type { StoredPack, WardPack, PackStats };
export { packStats, createWardPack, setWardPackEnabled, deleteWardPack, listWardPacks };
export { scanPackForPii, describePackFindings };
export type { PackPiiFinding };

const EXPORT_DIR = "shared";

/** 파일 이름에 못 쓰는 글자를 걷어낸다. 병동 이름에 슬래시가 들어가는 경우가 있다. */
function safeFileName(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "ward-dict"
  );
}

/**
 * 보내기 전 검사. 화면은 이 결과를 **반드시 보여준 뒤에** 보내야 한다.
 *
 * 사전은 전사본에서 자라난다. 정의를 쓰다가 예문에 환자 이름이 딸려 들어가고,
 * 치환 규칙에는 오인식된 이름이 그대로 남는다. 전사본은 내 폰에만 있지만
 * **사전은 남에게 주려고 만드는 물건이라** 위험은 오히려 이쪽이 크다.
 */
export interface PackExportCheck {
  findings: PackPiiFinding[];
  summary: string;
  /** 사람이 한 번 봐야 하는가. */
  needsReview: boolean;
}

export function checkPackBeforeShare(pack: WardPack): PackExportCheck {
  const findings = scanPackForPii(pack);
  return {
    findings,
    summary: describePackFindings(findings),
    needsReview: findings.length > 0,
  };
}

/**
 * 사전을 파일로 만들어 공유 시트를 연다.
 * 카카오톡·메일·에어드롭 등 기기에 있는 아무 경로로나 보낼 수 있다.
 *
 * **가리지 않고 그대로 내보낸다.** 사전은 사람이 손으로 쓴 물건이라 자동으로
 * 지우면 뜻이 망가진다 — "박 선생님이 알려준 말"에서 이름만 빼면 문장이 이상해지고,
 * 그건 지워야 하는 게 아니라 다시 써야 하는 것이다.
 * 그래서 `checkPackBeforeShare`로 짚어주고 고치는 것은 사람이 한다.
 */
export async function shareWardPack(pack: WardPack): Promise<void> {
  const Sharing = await import("expo-sharing");
  const dir = new Directory(Paths.cache, EXPORT_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  const file = new File(dir, `${safeFileName(pack.name)}.nsrdict.json`);
  if (file.exists) file.delete();
  file.create();
  file.write(exportWardPack(pack));

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(
      `이 기기에서는 공유를 열 수 없습니다. 파일은 여기 있습니다: ${file.uri}`,
    );
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: "application/json",
    dialogTitle: `${pack.name} 사전 보내기`,
    UTI: "public.json",
  });
}

export interface ImportOutcome extends ImportResult {
  /** 사용자가 파일 고르기를 취소했다. */
  canceled: boolean;
  /** 저장까지 마쳤는가. */
  saved: boolean;
}

/**
 * 파일을 골라 사전을 가져온다.
 *
 * 같은 id의 사전이 이미 있으면 덮어쓴다 — 선배가 사전을 고쳐서 다시 보냈을 때
 * 중복으로 쌓이지 않게 하기 위함이다.
 */
export async function importWardPackFromFile(): Promise<ImportOutcome> {
  const empty = { pack: null, errors: [], warnings: [], pendingCorrections: [] };
  const picked = await File.pickFileAsync({ mimeTypes: ["application/json"] });
  if (picked.canceled || !picked.result) {
    return { ...empty, canceled: true, saved: false };
  }

  let text: string;
  try {
    text = await picked.result.text();
  } catch (e) {
    return {
      ...empty,
      errors: [`파일을 읽지 못했습니다: ${e instanceof Error ? e.message : e}`],
      canceled: false,
      saved: false,
    };
  }

  const result = importWardPack(text);
  if (!result.pack) return { ...result, canceled: false, saved: false };

  await saveWardPack(result.pack);
  // 치환 규칙은 사전과 함께 저장하지 않는다. 확인 대기 목록으로만 보낸다.
  if (result.pendingCorrections.length > 0) {
    await addPendingCorrections(result.pendingCorrections, result.pack.id);
  }
  return { ...result, canceled: false, saved: true };
}

/** 붙여넣기로 가져오기. 파일로 주고받기 어려운 상황(사내망 등)을 위한 통로. */
export async function importWardPackFromText(text: string): Promise<ImportOutcome> {
  const result = importWardPack(text);
  if (!result.pack) return { ...result, canceled: false, saved: false };
  await saveWardPack(result.pack);
  if (result.pendingCorrections.length > 0) {
    await addPendingCorrections(result.pendingCorrections, result.pack.id);
  }
  return { ...result, canceled: false, saved: true };
}

/** 사전에 실릴 병동 사전들. 우선순위 오름차순 — 뒤에 오는 것이 이긴다. */
export async function activePacks(): Promise<WardPack[]> {
  return enabledWardPacks();
}

/** 사람이 읽을 요약 한 줄. 목록 화면에서 쓴다. */
export function describePack(stored: StoredPack): string {
  const stats = packStats(stored.pack);
  const where = [stored.pack.hospital, stored.pack.ward].filter(Boolean).join(" ");
  const bits = [`용어 ${stats.terms}개`, `표기 ${stats.surfaces}개`];
  if (stored.pack.author) bits.push(`만든 사람 ${stored.pack.author}`);
  return [where, bits.join(" · ")].filter(Boolean).join(" — ");
}
