/**
 * 병동 사전 (WardPack).
 *
 * 왜 필요한가
 * ----------
 * 내장 사전은 "어느 병원에서나 통하는 말"을 담는다. 그런데 실제로 신규를 막히게 하는 건
 * 그 병동에서만 쓰는 말이다. 약을 부르는 별명, 물품 위치를 가리키는 줄임말,
 * 선배들끼리 굳어진 표현 — 이런 건 어떤 사전에도 없고 앞으로도 안 실린다.
 *
 * 그래서 사전을 **세 층**으로 나눈다.
 *
 *   내장 사전    전국 어디서나 통하는 말        (이 저장소가 관리)
 *   병동 사전    우리 병동에서만 쓰는 말        (동료끼리 주고받음)  ← 이 파일
 *   내 사전      내가 직접 고친 것              (가장 우선)
 *
 * 뒤로 갈수록 우선한다. 내가 고친 게 병동 사전을 이기고, 병동 사전이 내장 사전을 이긴다.
 * 당연한 순서다 — 구체적인 쪽이 일반적인 쪽보다 맞을 확률이 높다.
 *
 * 주고받는다는 것의 의미
 * --------------------
 * 병동 사전은 파일로 오간다. 먼저 들어온 선배가 만들어 둔 것을 신규가 받는 식이다.
 * 그러면 **남이 만든 파일을 내 앱에 넣는 일**이 된다. 그래서 이 파일의 절반은 검증이다.
 *
 * 특히 하나는 아예 막아 뒀다. 병동 사전의 `corrections`(글자 치환 규칙)는
 * **가져와도 자동 적용되지 않는다.** 치환은 전사본의 글자를 그대로 바꾸는 일이라,
 * 악의가 아니라 실수만으로도 "십 밀리그램"이 "백 밀리그램"이 될 수 있다.
 * 가져온 치환 규칙은 제안 목록에만 올라가고, 사람이 하나씩 확인해야 켜진다.
 */

import type { LexiconEntry, TermCategory } from "./types.js";

export const WARD_PACK_SCHEMA_VERSION = 1;

/** 병동 사전이 함께 나르는 글자 치환 규칙. 가져오면 제안으로만 들어간다. */
export interface PackCorrection {
  from: string;
  to: string;
  /** 만든 사람 쪽에서 몇 번 반복된 교정인지. 신뢰도 참고용. */
  count?: number;
}

export interface WardPack {
  /** 안정적 식별자. 같은 id면 같은 사전으로 보고 덮어쓴다. */
  id: string;
  /** 사람이 읽을 이름. "○○병원 71병동" */
  name: string;
  hospital?: string;
  ward?: string;
  schemaVersion: number;
  updatedAt: number;
  terms: LexiconEntry[];
  corrections?: PackCorrection[];
  author?: string;
  note?: string;
}

// 파일로 오가는 것이라 상한이 필요하다. 없으면 잘못 만든 파일 하나로 앱이 멈춘다.
const LIMITS = {
  terms: 5000,
  corrections: 2000,
  aliases: 40,
  idLength: 80,
  shortText: 120,
  longText: 1000,
} as const;

const CATEGORIES: readonly TermCategory[] = [
  "assessment", "procedure", "device", "medication", "lab",
  "condition", "emergency", "documentation", "workflow", "role", "shift",
];

export interface CreateWardPackInput {
  id: string;
  name: string;
  hospital?: string;
  ward?: string;
  author?: string;
  note?: string;
  terms?: LexiconEntry[];
  now?: number;
}

export function createWardPack(input: CreateWardPackInput): WardPack {
  const pack: WardPack = {
    id: input.id,
    name: input.name,
    schemaVersion: WARD_PACK_SCHEMA_VERSION,
    updatedAt: input.now ?? 0,
    terms: input.terms ?? [],
  };
  if (input.hospital) pack.hospital = input.hospital;
  if (input.ward) pack.ward = input.ward;
  if (input.author) pack.author = input.author;
  if (input.note) pack.note = input.note;
  return pack;
}

/** 병동 사전에 용어를 넣는다. 같은 id가 있으면 갈아 끼운다. */
export function addTermToPack(
  pack: WardPack,
  entry: LexiconEntry,
  now: number,
): WardPack {
  const terms = pack.terms.filter((t) => t.id !== entry.id);
  terms.push(entry);
  return { ...pack, terms, updatedAt: now };
}

export function removeTermFromPack(
  pack: WardPack,
  termId: string,
  now: number,
): WardPack {
  return {
    ...pack,
    terms: pack.terms.filter((t) => t.id !== termId),
    updatedAt: now,
  };
}

// ────────────────────────────────────────────────────────────
//  내보내기 / 가져오기
// ────────────────────────────────────────────────────────────

/**
 * 파일로 내보낸다.
 *
 * 키 순서를 고정하는 이유: 같은 내용이면 같은 글자가 나와야 한다.
 * 그래야 두 사람이 받은 사전이 같은지 눈으로 비교할 수 있고, 버전 관리에도 올릴 수 있다.
 */
export function exportWardPack(pack: WardPack): string {
  const ordered = {
    schemaVersion: WARD_PACK_SCHEMA_VERSION,
    id: pack.id,
    name: pack.name,
    hospital: pack.hospital,
    ward: pack.ward,
    author: pack.author,
    note: pack.note,
    updatedAt: pack.updatedAt,
    terms: [...pack.terms]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => orderTermKeys(t)),
    corrections: pack.corrections
      ? [...pack.corrections].sort((a, b) => a.from.localeCompare(b.from))
      : undefined,
  };
  return JSON.stringify(ordered, null, 2);
}

function orderTermKeys(t: LexiconEntry): Record<string, unknown> {
  return {
    id: t.id,
    ko: t.ko,
    en: t.en,
    abbr: t.abbr,
    aliases: [...t.aliases].sort(),
    misheard: t.misheard ? [...t.misheard].sort() : undefined,
    category: t.category,
    definition: t.definition,
    informal: t.informal,
    formal: t.formal,
    pitfall: t.pitfall,
    sources: t.sources,
  };
}

export interface ImportResult {
  /** 검증을 통과한 사전. 통째로 못 쓰면 null. */
  pack: WardPack | null;
  /** 사전을 못 쓰게 만든 사유. */
  errors: string[];
  /** 일부를 버리고 나머지는 살렸을 때의 사유. */
  warnings: string[];
  /**
   * 가져온 글자 치환 규칙. **자동 적용되지 않는다.**
   * 사람이 하나씩 확인해 켜야 한다 (파일 머리말 참고).
   */
  pendingCorrections: PackCorrection[];
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * 남이 만든 파일을 읽는다.
 *
 * 항목 하나가 잘못됐다고 사전 전체를 버리지 않는다. 잘못된 것만 빼고 경고로 알린다.
 * 병동 사전은 손으로 만들어 주고받는 것이라 오타가 섞이는 게 정상이다.
 */
export function importWardPack(input: string | unknown): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pendingCorrections: PackCorrection[] = [];

  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return { pack: null, errors: ["파일을 읽지 못했습니다. JSON 형식이 아닙니다."], warnings, pendingCorrections };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { pack: null, errors: ["사전 파일의 형태가 아닙니다."], warnings, pendingCorrections };
  }
  const o = raw as Record<string, unknown>;

  const version = typeof o.schemaVersion === "number" ? o.schemaVersion : 0;
  if (version > WARD_PACK_SCHEMA_VERSION) {
    errors.push(
      `이 사전은 더 새로운 형식(v${version})입니다. 앱을 업데이트한 뒤 다시 열어 주세요.`,
    );
    return { pack: null, errors, warnings, pendingCorrections };
  }

  const id = str(o.id, LIMITS.idLength);
  const name = str(o.name, LIMITS.shortText);
  if (!id) errors.push("사전 id가 없습니다.");
  if (!name) errors.push("사전 이름이 없습니다.");
  if (!Array.isArray(o.terms)) errors.push("용어 목록이 없습니다.");
  if (errors.length > 0) return { pack: null, errors, warnings, pendingCorrections };

  const rawTerms = o.terms as unknown[];
  if (rawTerms.length > LIMITS.terms) {
    warnings.push(
      `용어가 너무 많아 앞의 ${LIMITS.terms}개만 가져왔습니다 (전체 ${rawTerms.length}개).`,
    );
  }

  const terms: LexiconEntry[] = [];
  const seenIds = new Set<string>();
  for (const item of rawTerms.slice(0, LIMITS.terms)) {
    const parsed = parseTerm(item);
    if (!parsed.entry) {
      warnings.push(parsed.reason ?? "알 수 없는 항목을 건너뛰었습니다.");
      continue;
    }
    if (seenIds.has(parsed.entry.id)) {
      warnings.push(`중복된 용어 id를 건너뛰었습니다: ${parsed.entry.id}`);
      continue;
    }
    seenIds.add(parsed.entry.id);
    terms.push(parsed.entry);
  }

  if (Array.isArray(o.corrections)) {
    for (const c of (o.corrections as unknown[]).slice(0, LIMITS.corrections)) {
      if (!c || typeof c !== "object") continue;
      const rec = c as Record<string, unknown>;
      const from = str(rec.from, LIMITS.shortText);
      const to = str(rec.to, LIMITS.shortText);
      if (!from || !to || from === to) continue;
      const entry: PackCorrection = { from, to };
      if (typeof rec.count === "number" && rec.count > 0) entry.count = Math.floor(rec.count);
      pendingCorrections.push(entry);
    }
    if (pendingCorrections.length > 0) {
      warnings.push(
        `글자 치환 규칙 ${pendingCorrections.length}건이 함께 왔습니다. ` +
          "자동으로 켜지지 않으며, 하나씩 확인한 뒤 적용됩니다.",
      );
    }
  }

  const pack: WardPack = {
    id: id as string,
    name: name as string,
    schemaVersion: WARD_PACK_SCHEMA_VERSION,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
    terms,
  };
  const hospital = str(o.hospital, LIMITS.shortText);
  const ward = str(o.ward, LIMITS.shortText);
  const author = str(o.author, LIMITS.shortText);
  const note = str(o.note, LIMITS.longText);
  if (hospital) pack.hospital = hospital;
  if (ward) pack.ward = ward;
  if (author) pack.author = author;
  if (note) pack.note = note;

  return { pack, errors, warnings, pendingCorrections };
}

function parseTerm(item: unknown): { entry: LexiconEntry | null; reason?: string } {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { entry: null, reason: "용어가 아닌 값을 건너뛰었습니다." };
  }
  const o = item as Record<string, unknown>;
  const id = str(o.id, LIMITS.idLength);
  const ko = str(o.ko, LIMITS.shortText);
  const definition = str(o.definition, LIMITS.longText);
  if (!id) return { entry: null, reason: "id 없는 용어를 건너뛰었습니다." };
  if (!ko) return { entry: null, reason: `표기가 없는 용어를 건너뛰었습니다: ${id}` };
  if (!definition) return { entry: null, reason: `뜻이 없는 용어를 건너뛰었습니다: ${ko}` };

  const category = CATEGORIES.includes(o.category as TermCategory)
    ? (o.category as TermCategory)
    : "workflow";

  const aliases = Array.isArray(o.aliases)
    ? (o.aliases as unknown[])
        .map((a) => str(a, LIMITS.shortText))
        .filter((a): a is string => a !== null)
        .slice(0, LIMITS.aliases)
    : [];

  const entry: LexiconEntry = { id, ko, aliases, category, definition };

  const en = str(o.en, LIMITS.shortText);
  const abbr = str(o.abbr, LIMITS.shortText);
  const formal = str(o.formal, LIMITS.shortText);
  const pitfall = str(o.pitfall, LIMITS.longText);
  if (en) entry.en = en;
  if (abbr) entry.abbr = abbr;
  if (o.informal === true) entry.informal = true;
  if (formal) entry.formal = formal;
  if (pitfall) entry.pitfall = pitfall;

  if (Array.isArray(o.misheard)) {
    const misheard = (o.misheard as unknown[])
      .map((m) => str(m, LIMITS.shortText))
      .filter((m): m is string => m !== null)
      .slice(0, LIMITS.aliases);
    if (misheard.length > 0) entry.misheard = misheard;
  }
  if (Array.isArray(o.sources)) {
    const sources = (o.sources as unknown[])
      .map((s) => str(s, LIMITS.idLength))
      .filter((s): s is string => s !== null)
      .slice(0, 10);
    if (sources.length > 0) entry.sources = sources;
  }

  return { entry };
}

// ────────────────────────────────────────────────────────────
//  병합 · 통계 · 제안
// ────────────────────────────────────────────────────────────

/**
 * 여러 병동 사전을 하나로 합친다.
 * **뒤에 오는 사전이 앞을 덮는다.** 호출부가 우선순위대로 넘긴다.
 */
export function mergeWardPacks(packs: readonly WardPack[]): LexiconEntry[] {
  const byId = new Map<string, LexiconEntry>();
  for (const pack of packs) {
    for (const term of pack.terms) byId.set(term.id, term);
  }
  return [...byId.values()];
}

export interface PackStats {
  terms: number;
  informal: number;
  withPitfall: number;
  surfaces: number;
  categories: Partial<Record<TermCategory, number>>;
}

export function packStats(pack: WardPack): PackStats {
  const categories: Partial<Record<TermCategory, number>> = {};
  const surfaces = new Set<string>();
  let informal = 0;
  let withPitfall = 0;
  for (const t of pack.terms) {
    categories[t.category] = (categories[t.category] ?? 0) + 1;
    if (t.informal) informal += 1;
    if (t.pitfall) withPitfall += 1;
    surfaces.add(t.ko);
    for (const a of t.aliases) surfaces.add(a);
    for (const m of t.misheard ?? []) surfaces.add(m);
  }
  return { terms: pack.terms.length, informal, withPitfall, surfaces: surfaces.size, categories };
}

/** 병동 사전에 새로 넣을 만한 말 후보. */
export interface PackTermSuggestion {
  /** 사용자가 반복해서 고쳐 온 말. */
  surface: string;
  /** 몇 번 반복됐는지. */
  count: number;
  /** 왜 후보인지. */
  reason: "unknown-term" | "repeated-correction";
}

/**
 * 사용자 교정 이력에서 "병동 사전에 넣을 만한 말"을 찾는다.
 *
 * 판정 기준은 단순하다. **고친 결과가 어느 사전에도 없으면** 그건 이 병동에서만
 * 쓰는 말일 가능성이 높다. 내장 사전에 있는 말로 고쳤다면 그냥 오인식 교정이고,
 * 없는 말로 고쳤다면 사전에 그 말 자체가 빠진 것이다.
 *
 * @param isKnown 이 표기가 이미 사전에 있는가 (보통 `lexicon.lookup(s) !== null`)
 */
export function suggestPackTerms(
  corrections: readonly { from: string; to: string; count: number }[],
  isKnown: (surface: string) => boolean,
  minCount = 2,
): PackTermSuggestion[] {
  const out: PackTermSuggestion[] = [];
  const seen = new Set<string>();
  for (const rule of corrections) {
    if (rule.count < minCount) continue;
    if (isKnown(rule.to)) continue;
    if (seen.has(rule.to)) continue;
    seen.add(rule.to);
    out.push({ surface: rule.to, count: rule.count, reason: "unknown-term" });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** 제안을 실제 용어 항목으로 만든다. 뜻은 사람이 채워야 한다. */
export function draftTermFromSuggestion(
  suggestion: PackTermSuggestion,
  packId: string,
  definition: string,
  category: TermCategory = "workflow",
): LexiconEntry {
  const slug = suggestion.surface.replace(/\s+/g, "-").slice(0, 40);
  return {
    id: `${packId}-${slug}`,
    ko: suggestion.surface,
    aliases: [],
    category,
    definition,
    informal: true,
  };
}
