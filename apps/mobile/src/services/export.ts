/**
 * 밖으로 나가는 길목.
 *
 * 전사본·보고서가 기기를 떠나는 경로는 여기 하나로 모은다.
 * 흩어져 있으면 언젠가 한 군데를 빠뜨리고, 그 한 군데로 환자 이름이 나간다.
 *
 * 여기서 하는 일은 세 가지다.
 *   1. `deidentify()` 로 개인정보를 가린다
 *   2. 무엇을 몇 건 가렸는지 **사용자에게 보여준다**
 *   3. 가리기가 놓쳤을 수 있는 것을 경고한다
 *
 * 저장할 때는 가리지 않는다. 이유는 core 의 `deidentify.ts` 머리말에 적어 뒀다 —
 * 전사본은 증거이고, 대상이 지워진 증거는 값이 떨어진다.
 */

import { Directory, File, Paths } from "expo-file-system";
import {
  checkBeforeExport,
  deidentify,
  describeRedactions,
  PII_LABELS,
  type DeidentifyResult,
  type ExportWarning,
  type PiiKind,
} from "@nsr/core";
import { getSetting, setSetting } from "../db";

export const PRIVACY_KEYS = {
  /** 가리기를 켤 것인가. 기본 켜짐. */
  maskEnabled: "privacy.maskPii",
  /** 끌 종류. 기본은 병실·침상만 꺼져 있다. */
  maskDisabled: "privacy.maskDisabledKinds",
  /** 사용자가 직접 등록한, 반드시 가릴 말들. */
  extraTerms: "privacy.extraTerms",
} as const;

/** 화면에서 켜고 끌 수 있는 항목들. 순서가 곧 화면 순서다. */
export const MASKABLE_KINDS: { kind: PiiKind; label: string; hint: string }[] = [
  { kind: "name", label: PII_LABELS.name, hint: "호칭이 포함된 성명 (\"김○○ 님\", \"○○ 선생님\")" },
  { kind: "phone", label: PII_LABELS.phone, hint: "휴대전화 및 지역번호" },
  { kind: "rrn", label: PII_LABELS.rrn, hint: "주민등록번호" },
  { kind: "mrn", label: PII_LABELS.mrn, hint: "등록번호·차트번호" },
  { kind: "dob", label: PII_LABELS.dob, hint: "생년월일" },
  {
    kind: "location",
    label: PII_LABELS.location,
    hint: "병실·침상 번호 (기본 비활성화 — 기록 필요 시 설정)",
  },
];

export interface PrivacySettings {
  enabled: boolean;
  disabled: PiiKind[];
  extraTerms: string[];
}

export async function loadPrivacySettings(): Promise<PrivacySettings> {
  const [enabled, disabled, extraTerms] = await Promise.all([
    getSetting<boolean>(PRIVACY_KEYS.maskEnabled, true),
    getSetting<PiiKind[]>(PRIVACY_KEYS.maskDisabled, ["location"]),
    getSetting<string[]>(PRIVACY_KEYS.extraTerms, []),
  ]);
  return { enabled, disabled, extraTerms };
}

export async function savePrivacySettings(next: PrivacySettings): Promise<void> {
  await setSetting(PRIVACY_KEYS.maskEnabled, next.enabled);
  await setSetting(PRIVACY_KEYS.maskDisabled, next.disabled);
  await setSetting(PRIVACY_KEYS.extraTerms, next.extraTerms);
}

export interface RedactedText {
  text: string;
  /** 가리기를 실제로 돌렸는가. 설정에서 꺼 두면 false. */
  masked: boolean;
  result: DeidentifyResult;
  /** "이름 2건, 전화번호 1건을 가렸습니다" */
  summary: string;
  warnings: ExportWarning[];
}

/**
 * 사용자 설정에 맞게 가린다.
 *
 * 설정에서 꺼 뒀더라도 `deidentify` 는 돌린다. 무엇이 들어 있는지는
 * 알려줘야 하기 때문이다 — 다만 **본문은 원문 그대로 내보낸다.**
 * "끄겠다"는 선택은 존중하되, 무엇을 내보내는지 모르게 두지는 않는다.
 */
export async function redactForExport(
  text: string,
  options: { includesAudio?: boolean } = {},
): Promise<RedactedText> {
  const settings = await loadPrivacySettings();
  const result = deidentify(text, {
    disable: settings.disabled,
    extraTerms: settings.extraTerms,
  });
  const warnings = checkBeforeExport(result, options);

  if (!settings.enabled) {
    return {
      text,
      masked: false,
      result,
      summary:
        result.redactedCount > 0
          ? // 핵심 문구는 core 가 만든다. 꼬리만 갈아끼우는데, 조사(을/를)가
            // 자동 선택이라 글자 그대로 찾으면 안 맞는다 — 정규식으로 꼬리를 잡는다.
            `가리기가 꺼져 있습니다. 이대로 내보내면 ${describeRedactions(result).replace(
              /[을를] 가렸습니다\.$/,
              "이 그대로 포함됩니다.",
            )}`
          : "마스킹이 비활성화되어 있습니다.",
      warnings,
    };
  }

  return {
    text: result.text,
    masked: true,
    result,
    summary: describeRedactions(result),
    warnings,
  };
}

/**
 * 네트워크로 보내기 전 가리기.
 *
 * 내보내기와 다른 점: **끌 수 없다.**
 *
 * 파일로 내보내는 것은 내 폰에서 내 손으로 나가는 일이라 사용자가 판단할 수 있다.
 * 하지만 남의 서버로 보내는 것은 되돌릴 수 없다. 한 번 나가면 로그에 남고,
 * 그 로그를 우리가 지울 수 없다. 그래서 이 경로에서는 가리기를 끄는 선택지를 두지 않는다.
 *
 * 사용자가 추가로 등록한 말은 반영한다 — 그건 가리기를 **더 하는** 방향이다.
 */
export async function redactForNetwork(text: string): Promise<RedactedText> {
  const settings = await loadPrivacySettings();
  const result = deidentify(text, {
    disable: settings.disabled,
    extraTerms: settings.extraTerms,
  });
  return {
    text: result.text,
    masked: true,
    result,
    summary: describeRedactions(result),
    warnings: checkBeforeExport(result),
  };
}

// ────────────────────────────────────────────────────────────
//  파일로 내보내기
// ────────────────────────────────────────────────────────────

const EXPORT_DIR = "shared";

function safeFileName(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "nsr-export"
  );
}

/**
 * 텍스트를 파일로 만들어 공유 시트를 연다.
 *
 * 캐시 폴더에 쓴다. 공유가 끝나면 OS 가 알아서 비운다 —
 * 내보낸 사본이 기기에 계속 남아 있을 이유가 없다.
 */
export async function shareText(input: {
  text: string;
  fileName: string;
  title: string;
}): Promise<{ shared: boolean; message?: string }> {
  const Sharing = await import("expo-sharing");
  const dir = new Directory(Paths.cache, EXPORT_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  const file = new File(dir, `${safeFileName(input.fileName)}.md`);
  if (file.exists) file.delete();
  file.create();
  file.write(input.text);

  if (!(await Sharing.isAvailableAsync())) {
    return {
      shared: false,
      message: `이 기기에서는 공유 기능을 실행할 수 없습니다. 파일 위치: ${file.uri}`,
    };
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/markdown",
    dialogTitle: input.title,
    UTI: "net.daringfireball.markdown",
  });
  return { shared: true };
}

/** 내보내고 남은 파일 정리. 데이터 삭제와 앱 시작 시 부른다. */
export function clearExportCache(): void {
  try {
    const dir = new Directory(Paths.cache, EXPORT_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // 캐시는 OS 도 지운다. 실패해도 문제되지 않는다.
  }
}
