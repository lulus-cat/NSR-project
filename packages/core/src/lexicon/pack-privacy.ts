/**
 * 병동 사전을 남에게 주기 전 검사.
 *
 * 왜 사전에도 이게 필요한가
 * ----------------------
 * 병동 사전은 **전사본에서 자라난다.** 근무 중에 나온 말을 보고 "이건 우리 병동 말이네"
 * 하고 담는 물건이라, 담다 보면 환자 이야기가 딸려 들어간다.
 *
 *   정의에 예문을 적다가  → "김OO님 드레싱할 때 쓰는 말"
 *   주의점을 적다가       → "302호 할머니는 이걸 다르게 부르심"
 *   치환 규칙에           → 오인식된 환자 이름이 그대로
 *
 * 전사본은 내 폰에만 있지만 **사전은 남에게 주려고 만든 물건이다.** 그래서
 * 위험은 오히려 이쪽이 크다. 한 번 보내면 받은 사람 폰에 남고, 그 사람이
 * 또 누구에게 보낼지는 내가 모른다.
 *
 * 여기서는 **가리지 않고 찾아서 보여주기만 한다.**
 * 사전은 사람이 손으로 쓴 물건이라 자동으로 고치면 뜻이 망가진다.
 * "박 선생님이 알려준 말"에서 이름을 지우면 문장이 이상해지고,
 * 애초에 그 문장은 지워야 하는 게 아니라 **다시 써야** 하는 것이다.
 * 그래서 어디에 무엇이 있는지 짚어주고, 고치는 것은 사람이 한다.
 */

import { deidentify, type PiiKind } from "../transcription/deidentify.js";
import type { WardPack } from "./ward-pack.js";

export interface PackPiiFinding {
  /** 어느 용어에서 나왔는지. 사전 자체 항목(이름·메모)이면 null. */
  termId: string | null;
  /** 사람이 읽을 위치. "손소독 — 주의점" */
  where: string;
  kind: PiiKind;
  /** 걸린 말. 사용자에게 보여줘 판단하게 한다. */
  found: string;
  /** 그 말이 들어 있던 문장. 앞뒤를 봐야 오탐인지 안다. */
  context: string;
}

const FIELD_LABELS = {
  name: "사전 이름",
  note: "메모",
  ko: "표기",
  definition: "정의",
  pitfall: "주의점",
  alias: "별칭",
  misheard: "오인식 표기",
  correctionFrom: "치환 전",
  correctionTo: "치환 후",
} as const;

/**
 * 사전 전체를 훑어 개인정보로 보이는 것을 찾는다.
 *
 * 병실·침상은 켠다. 전사본에서는 임상적으로 필요해 기본으로 꺼 두지만,
 * **사전에 병실 번호가 들어갈 이유는 없다.** 용어 설명에 "302호"가 있다면
 * 그건 십중팔구 지워야 할 예문이다.
 */
export function scanPackForPii(pack: WardPack): PackPiiFinding[] {
  const findings: PackPiiFinding[] = [];

  const check = (
    termId: string | null,
    label: string,
    text: string | undefined,
  ): void => {
    if (!text) return;
    const result = deidentify(text, { disable: [] });
    for (const r of result.redactions) {
      findings.push({
        termId,
        where: label,
        kind: r.kind,
        found: r.original,
        context: text,
      });
    }
  };

  check(null, FIELD_LABELS.name, pack.name);
  check(null, FIELD_LABELS.note, pack.note);

  for (const term of pack.terms) {
    const at = (field: string) => `${term.ko} — ${field}`;
    check(term.id, at(FIELD_LABELS.ko), term.ko);
    check(term.id, at(FIELD_LABELS.definition), term.definition);
    check(term.id, at(FIELD_LABELS.pitfall), term.pitfall);
    for (const alias of term.aliases) check(term.id, at(FIELD_LABELS.alias), alias);
    for (const m of term.misheard ?? []) check(term.id, at(FIELD_LABELS.misheard), m);
  }

  for (const c of pack.corrections ?? []) {
    check(null, `치환 "${c.from}" → "${c.to}" — ${FIELD_LABELS.correctionFrom}`, c.from);
    check(null, `치환 "${c.from}" → "${c.to}" — ${FIELD_LABELS.correctionTo}`, c.to);
  }

  return findings;
}

/**
 * 사람에게 보여줄 한 줄.
 *
 * 오탐이 섞여 있다는 것을 반드시 함께 말한다. "3건 발견"만 보여주면
 * 사용자는 그게 전부 진짜라고 믿고, 다음부터는 경고를 안 읽게 된다.
 */
export function describePackFindings(findings: PackPiiFinding[]): string {
  if (findings.length === 0) {
    return "개인정보로 보이는 것을 찾지 못했습니다. 그래도 한 번 훑어보고 보내세요.";
  }
  return (
    `확인이 필요한 곳이 ${findings.length}군데 있습니다. ` +
    "일반명사가 이름으로 잘못 걸리기도 하니 직접 보고 판단하세요."
  );
}
