/**
 * 음성인식과 전사 후처리 파이프라인.
 *
 * 원리는 docs/02-transcription-pipeline.md에 정리되어 있다. 여기는 그 구현이다.
 *
 * 이 앱은 이제 전사를 하지 않는다 (0.1.8x)
 * ---------------------------------------
 * 글자로 바꾸는 일은 **티로 하나**가 한다. 앱이 하는 일은 녹음, 티로 앱으로
 * 보내기, 그리고 티로가 받아적은 글자를 가져와 교정·저장하는 것이다.
 *
 * 지운 길과 이유
 *   - 온디바이스(whisper.cpp): 8시간 기록에 폰이 몇 시간, 뜨겁고 부정확했다.
 *   - 콜랩·내 PC 서버(휘스퍼): 사용자가 매번 노트북을 켜고 주소를 이어야 했다.
 *     3분 준비가 매 근무마다면 안 쓰게 된다. 실제로 안 썼다.
 *   - 티로 파일 올리기(Voice File Job): 티로가 이 계정에 안 열어 준다(403).
 *   - Gemini 직접 전사: 병동 음성이 구글로 가고 무료 티어는 학습에 쓰일 수 있다.
 *
 * 남은 것은 여기다: 문장 나누기·교정·저장(saveImportedSegments)과 티로 창구.
 */

import {
  buildLexicon,
  collapseRepeatedSentences,
  deidentify,
  correctTranscript,
  splitAllIntoSentences,
  generateCards,
  buildShiftReport,
  reportToMarkdown,
  scoreShift,
  type TaeumScore,
  type Lexicon,
  type TranscriptSegment,
  type CardSourceSegment,
  type Edit,
  type TermAnnotation,
} from "@nsr/core";
import {
  enabledWardPacks,
  knownEntryIds,
  listSegmentsAbsolute,
  listUserTerms,
  loadCorrectionMemory,
  saveCards,
  saveSegments,
  saveShiftReport,
  saveTaeumScore,
  setRecordingState,
  type RecordingRow,
} from "../db";
import { getSetting, setSetting } from "../db";
import { logDebug } from "./debug";

/** 티로에서 가져온 문장 한 토막. 앱이 만드는 것이 아니라 받아 오는 것이다. */
export interface ImportedSegment {
  startSec: number;
  endSec: number;
  text: string;
  speakerId?: string;
}

// 티로는 전사만 한다 — 대화 LLM 공급자가 아니므로 키도 여기 따로 둔다.
const TIRO_KEY = "nsr.tiro.key";
/** 찾아 둔 워크스페이스 guid. 열쇠가 바뀌면 지운다. */
const TIRO_WORKSPACE_KEY = "tiro.workspaceGuid";

export async function getTiroKey(): Promise<string | null> {
  const SecureStore = await import("expo-secure-store");
  return SecureStore.getItemAsync(TIRO_KEY);
}

export async function setTiroKey(key: string | null): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  // 열쇠가 바뀌면 워크스페이스도 사전도 새 계정 기준으로 다시 잡아야 한다.
  await setSetting(TIRO_WORKSPACE_KEY, "");
  await setSetting("tiro.pushedWords", []);
  if (key && key.trim()) {
    await SecureStore.setItemAsync(TIRO_KEY, key.trim(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(TIRO_KEY);
  }
}

/** 병동 사전 — 사용자가 넣은 말 + 켜 둔 병동 팩. 교정과 티로 단어장이 쓴다. */
export async function loadLexicon(): Promise<Lexicon> {
  const [userTerms, packs] = await Promise.all([listUserTerms(), enabledWardPacks()]);
  return buildLexicon({ userTerms, packs });
}

/**
 * ASR 이 준 덩어리를 문장으로 펴고, 교정하고, 저장한다.
 *
 * 지금 들어오는 길은 하나뿐이다 — 티로 노트 가져오기(`tiro-notes.ts`). 파일 없이
 * 전사본만 들어온다. 교정 규칙과 문장 나누기를 한 곳에 두려고 함수는 남겨 둔다.
 */
export async function saveImportedSegments(input: {
  recordingId: string;
  shiftId: string | null;
  segments: ImportedSegment[];
  onProgress?: (pct: number, note?: string) => void;
}): Promise<number> {
  const lexicon = await loadLexicon();
  const memory = await loadCorrectionMemory();

  // 1) ASR 덩어리를 문장으로 편다.
  //
  //    티로가 주는 것은 문단(화자 한 차례)이지 문장이 아니다. 문장으로 나눠야
  //    화자를 문장별로 지정하고, 한 문장만 골라 고치고, 카드 예문이 문단째로
  //    들어가지 않는다. **교정보다 먼저** 나눠야 교정 위치가 문장 기준으로 잡힌다.
  const rawSegments: TranscriptSegment[] = input.segments.map((s, i) => ({
    id: `${input.recordingId}#s${i}`,
    startSec: s.startSec,
    endSec: s.endSec,
    rawText: s.text,
    text: s.text,
    speakerId: s.speakerId,
  }));
  // 같은 문장이 세 번 이상 연달아 나오면 디코더 환각으로 보고 접는다
  // ("네. 네. 네." 수십 줄이 1,600문장을 만든 실사례). 재생 구간은 넓혀 둔다.
  const sentences = collapseRepeatedSentences(splitAllIntoSentences(rawSegments));

  // 2) 문장마다 교정한다.
  //
  //    3시간짜리 통짜 기록이면 문장이 수천 개다. 교정은 동기 CPU 작업이라
  //    한 번에 돌리면 JS 스레드가 몇 분씩 멎고, 화면이 100% 에서 굳은 채
  //    안드로이드가 "앱이 응답하지 않음"으로 죽인다 — 실사용 사고다.
  //    덩어리로 나눠 이벤트 루프에 숨 쉴 틈을 주고, 어디까지 왔는지 말한다.
  const segments: TranscriptSegment[] = [];
  const perSegment: { edits: Edit[]; annotations: TermAnnotation[] }[] = [];
  const CHUNK = 25;

  for (let i = 0; i < sentences.length; i++) {
    if (i % CHUNK === 0) {
      input.onProgress?.(100, `뱉어낸 글자 예쁘게 빚는 중 — ${i}/${sentences.length} 문장`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const sentence = sentences[i];
    // asrEngine: "other" — 휘스퍼 오인식 목록은 티로 전사본에 안 맞는다.
    // 티로는 다르게 틀리기 때문이다. 들이대면 멀쩡한 말을 엉뚱하게 바꾼다.
    const corrected = correctTranscript(sentence.text, { lexicon, memory, asrEngine: "other" });
    segments.push({ ...sentence, text: corrected.text });
    perSegment.push({ edits: corrected.edits, annotations: corrected.annotations });
  }

  input.onProgress?.(100, `폰에 저장하는 중 (${segments.length}문장)`);
  await saveSegments(input.recordingId, input.shiftId, segments, perSegment);
  return segments.length;
}

/**
 * 근무가 끝난 뒤 한 번 돌린다.
 * 전사본 전체를 모아 학습카드·태움 지표·보고서를 만든다.
 */
/**
 * 태움 지표만 다시 센다.
 *
 * 예전에는 '카드·보고서 만들기' 버튼이 이걸 함께 계산했는데, 그 버튼을
 * 없애면서 지표가 영영 안 생기게 됐다. 지표는 규칙 기반이라 AI 가 필요 없고
 * 문장만 있으면 되니, 근무 화면이 열릴 때마다 조용히 다시 센다.
 * 화자 지정을 나중에 고쳐도 그때 값이 따라온다.
 */
export async function refreshTaeumScore(shiftId: string): Promise<TaeumScore | null> {
  // 근무 전체 기준 시각으로 본다. 파일마다 0 부터 다시 세면 '질문이 몰린 구간'
  // 계산이 파일 경계마다 뒤로 흘러 없던 점수를 만든다.
  const { segments } = await listSegmentsAbsolute(shiftId);
  if (segments.length === 0) return null;
  const score = scoreShift(segments);
  await saveTaeumScore(shiftId, score);
  return score;
}

export async function finalizeShift(input: {
  shiftId: string;
  date: string;
  dutyLabel: string;
  recordedSec: number;
  now?: number;
}): Promise<{ cardsAdded: number; taeumScore: number }> {
  const now = input.now ?? Date.now();
  const lexicon = await loadLexicon();
  const { segments } = await listSegmentsAbsolute(input.shiftId);
  const known = await knownEntryIds();

  // 세그먼트 본문을 다시 교정 파이프라인에 통과시켜 주석을 얻는다.
  // (DB의 annotations를 읽어도 되지만, 사용자가 본문을 직접 고쳤을 수 있어 재계산이 안전하다.)
  // asrEngine: "other" — 여기 오는 본문은 이미 교정을 마친 것이라 오인식 표기가 없다.
  // 다시 misheard 를 돌리면 교정된 말을 또 건드리고, 제미나이 전사본이면 애초에 안 맞는다.
  const cardSegments: CardSourceSegment[] = [];
  const termIds: string[] = [];
  for (const seg of segments) {
    const corrected = correctTranscript(seg.text, { lexicon, asrEngine: "other" });
    cardSegments.push({
      segmentId: seg.id,
      text: corrected.text,
      annotations: corrected.annotations,
      speakerRole: seg.speakerRole,
      startSec: seg.startSec,
    });
    for (const id of corrected.termIds) {
      if (!termIds.includes(id)) termIds.push(id);
    }
  }

  const cards = generateCards({
    shiftId: input.shiftId,
    segments: cardSegments,
    lexicon,
    knownEntryIds: known,
    now,
  });
  const cardsAdded = await saveCards(cards, now);

  const taeum = scoreShift(segments);
  await saveTaeumScore(input.shiftId, taeum);

  const report = buildShiftReport({
    shiftId: input.shiftId,
    date: input.date,
    dutyLabel: input.dutyLabel,
    recordedSec: input.recordedSec,
    segments: cardSegments,
    termIds,
    knownEntryIds: known,
    taeum,
    lexicon,
  });
  await saveShiftReport(input.shiftId, reportToMarkdown(report), report);

  // 등장 용어 빈도를 누적한다. 다음 전사의 프롬프트 우선순위가 여기서 나온다.
  const usage = await getSetting<Record<string, number>>("lexicon.usageCounts", {});
  for (const id of termIds) usage[id] = (usage[id] ?? 0) + 1;
  const { setSetting } = await import("../db");
  await setSetting("lexicon.usageCounts", usage);

  return { cardsAdded, taeumScore: taeum.score };
}

/* ── Tiro ────────────────────────────────────────────────────────────────
 *
 * 앱이 티로에 하는 일은 두 가지다.
 *   1) 티로 앱으로 녹음해 **이미 전사된 노트의 글자를 가져온다** (`tiro-notes.ts`).
 *   2) 병동 사전의 새 말을 **티로 단어장에 올린다** (아래 autoPushTiroWords).
 *
 * 파일을 올려 전사하던 길(Voice File Job)은 0.1.8x 에서 지웠다. 그 API 는
 * 워크스페이스마다 티로가 켜 줘야 열리는데 이 계정에는 안 켜져 있어서, 올리기
 * 코드를 남겨 두면 화면만 '전사되는 척'하고 매번 403 으로 끝났다.
 *
 * 인증: `Bearer {id}.{secret}` — 발급받은 API 키를 그대로 쓴다.
 *
 * 단어장이 왜 중요한가
 *   전사 요청에 맥락·주제를 넣는 자리는 없다. 대신 **계정에 단어를 등록해 두면**
 *   전사할 때 티로가 알아서 참조한다 (`Uses word memories from the key's user,
 *   workspace, and organization scopes`). 그래서 사전을 올려 두는 것이 곧 다음
 *   녹음의 정확도다. 요청마다 보낼 필요는 없다 — 한 번 올리면 계속 쓰인다.
 */
export const TIRO_API = "https://api.tiro.ooo";
/** 벌크 한 번에 보낼 단어 수. 티로 상한은 1000이고, 사전은 345개라 한 번에 끝난다. */
const TIRO_BULK = 500;

/**
 * 티로 오류를 사람 말로.
 *
 * 403 을 전부 "열쇠가 틀렸다"고 적었던 것이 사고였다. 열쇠는 멀쩡한데 권한이
 * 없어서 막힌 것을, 화면은 열쇠를 다시 넣으라고 적었다. 맞는 열쇠를 몇 번이고
 * 다시 넣게 만들었다. 그래서 401(열쇠)과 403(권한)을 갈라 적는다.
 */
export async function tiroError(res: Response, doing: string): Promise<string> {
  const detail = await res.text().catch(() => "");
  // 원문 JSON 은 사용자에게 보여줄 말이 아니다. 진단은 디버그 기록으로 남긴다.
  void logDebug(`티로 ${doing} 실패 ${res.status}: ${detail.slice(0, 300)}`);

  let message = "";
  try {
    message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    // JSON 이 아니면 상태 코드만 보고 판단한다.
  }

  if (res.status === 401) return "티로 열쇠가 맞지 않아요. 설정에서 다시 넣어 주세요.";
  if (res.status === 403) {
    // 앱이 티로에 하는 일은 노트 읽기와 단어장 올리기뿐이다. 그게 막히면
    // 열쇠에 그 권한이 없는 것이다. (파일 전사 403000·403013 은 올리기 경로를
    // 지우면서 함께 없앴다.)
    if (message) void logDebug(`티로 403 사유: ${message.slice(0, 120)}`);
    return "이 열쇠에 권한이 없어요. 티로에서 권한을 켜고 열쇠를 새로 만들어 주세요.";
  }
  if (res.status === 429) return "티로가 바빠요. 잠시 뒤 다시 해 주세요.";
  if (detail.includes("workspaceGuid")) {
    return "티로 워크스페이스를 찾지 못했어요. 열쇠를 다시 넣고 해 보세요.";
  }
  return `티로가 ${doing}에 실패했어요 (${res.status}). 잠시 뒤 다시 해 주세요.`;
}

/**
 * 이 열쇠가 쓸 워크스페이스 guid.
 *
 * 티로 열쇠에는 워크스페이스에 매인 것과 안 매인 것이 있다. 안 매인 열쇠(개인
 * 계정 열쇠가 그렇다)로 작업을 만들면 400 을 준다 — "workspaceGuid is required
 * for workspace-unbound API keys". 그래서 만들기 전에 한 번 물어보고 함께 보낸다.
 * 매인 열쇠는 이 값을 안 보내도 되고, 보내면 자기 워크스페이스와 같아야 하므로
 * `/workspaces/me` 가 준 값을 그대로 쓰는 것이 양쪽 모두에 맞다.
 *
 * 한 번 찾으면 설정에 남긴다. 열쇠를 바꾸면 `setTiroKey` 가 지운다.
 */
export async function tiroWorkspaceGuid(apiKey: string): Promise<string | undefined> {
  const cached = await getSetting<string>(TIRO_WORKSPACE_KEY, "");
  if (cached) return cached;
  const headers = { authorization: `Bearer ${apiKey}` };
  try {
    // 1) 열쇠에 딸린 워크스페이스가 있으면 그것이 정답이다.
    const me = await fetch(`${TIRO_API}/v1/external/workspaces/me`, { headers });
    let guid = me.ok ? ((await me.json()) as { guid?: string }).guid : undefined;
    // 2) 없으면(404) 갈 수 있는 워크스페이스 목록에서 첫 번째를 쓴다.
    if (!guid) {
      const list = await fetch(`${TIRO_API}/v1/external/workspaces`, { headers });
      if (list.ok) {
        const data = (await list.json()) as {
          workspaces?: { guid?: string }[];
          content?: { guid?: string }[];
        };
        guid = (data.workspaces ?? data.content ?? [])[0]?.guid;
      }
    }
    if (guid) await setSetting(TIRO_WORKSPACE_KEY, guid);
    return guid;
  } catch {
    // 못 물어봤으면 안 보낸다. 매인 열쇠면 그래도 돌아간다.
    return undefined;
  }
}

/**
 * 병동 사전을 티로 계정 단어장에 올린다.
 *
 * 한 번 올려 두면 그 뒤 전사에 자동으로 쓰인다. 이미 있는 말은 409 로 오는데,
 * 그건 실패가 아니라 "이미 됨"이므로 성공으로 센다.
 *
 * 제약: entry 는 1~63자이고 공백을 못 넣는다. "팁 컬처" 처럼 띄어 쓰는 용어는
 * 그래서 못 올린다 — 건너뛴 개수를 돌려주니 화면이 알려 준다.
 */
const TIRO_PUSHED = "tiro.pushedWords";

/**
 * 사전에서 티로에 올릴 수 있는 말만 고른다.
 *
 * 길이·공백만 보던 것이 구멍이었다. 전사본에서 낱말 하나를 눌러 '단어장에
 * 넣기' 를 하면 그 말이 그대로 사전이 되고(사람 이름도 된다), 티로 노트 화면을
 * 열 때마다 사전이 티로 계정으로 올라간다 — 남의 서버에 영구히 남는다.
 * 서버 쪽 같은 기능에는 이미 검사가 있었다 (server/nsr_server/tiro.py word_reject).
 *
 * 그래서 여기서도 **가려질 만한 말은 안 올린다.** deidentify 가 무엇이든 잡으면
 * 사람을 가리키는 말로 보고 뺀다.
 */
function tiroWordsOf(lexicon: Lexicon): { words: { entry: string; subEntry?: string }[]; skipped: number } {
  const ok = (w?: string) =>
    !!w &&
    w.length <= 63 &&
    !/\s/.test(w) &&
    !w.includes("[") &&
    !w.includes("]") &&
    deidentify(w, { disable: [] }).redactions.length === 0;
  const words: { entry: string; subEntry?: string }[] = [];
  let skipped = 0;
  for (const e of lexicon.entries) {
    if (!ok(e.ko)) {
      skipped++;
      continue;
    }
    const sub = [e.abbr, e.en].find(ok);
    words.push({ entry: e.ko, ...(sub ? { subEntry: sub } : {}) });
  }
  return { words, skipped };
}

/**
 * 단어를 **한 번에** 올린다 (`/word-memories/bulk`, 요청당 1000개까지).
 *
 * 예전에는 낱말마다 POST 를 한 번씩 보냈다. 병동 사전이 345개라 첫 전사 때
 * 345개의 요청이 연달아 나갔고, 티로가 429(너무 바쁨)로 막았다. 그 뒤 요청은
 * 401/403 으로도 떨어졌다 — 사용자에게는 "열쇠가 맞지 않아요"로 보였다.
 * 벌크는 같은 일을 요청 한 번으로 끝낸다. 이미 있는 말은 티로가 조용히 건너뛴다.
 *
 * 돌려주는 값: 새로 만들어진 개수와 이미 있던 개수. 실패는 던진다 —
 * 부르는 쪽이 사용자에게 보일지(수동 버튼) 삼킬지(전사 직전)를 정한다.
 */
async function pushTiroWordsBulk(
  apiKey: string,
  words: { entry: string; subEntry?: string }[],
): Promise<{ added: number; already: number }> {
  const res = await fetch(`${TIRO_API}/v1/external/users/me/word-memories/bulk`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ entries: words }),
  });
  if (!res.ok) throw new Error(await tiroError(res, "사전 올리기"));
  // 응답에는 **새로 만들어진 것만** 온다. 나머지는 이미 있던 말이다.
  const body = (await res.json().catch(() => null)) as { content?: unknown[] } | null;
  const added = Array.isArray(body?.content) ? body.content.length : words.length;
  return { added, already: words.length - added };
}

/**
 * 티로 단어장에 **새로 생긴 말만** 올린다 (노트 가져오기 화면이 부른다).
 *
 * 사용자가 버튼을 눌러야 하는 기능은 결국 안 누르게 된다. 그래서 티로 노트를 보러
 * 갈 때마다 사전을 훑어 아직 안 올린 것이 있으면 그것만 보낸다. 새 말이 없으면
 * 요청이 0건이라 평소에는 아무 비용이 없다.
 *
 * 올려 두면 **다음에 티로 앱으로 녹음할 때** 티로가 그 말을 알아듣는다. 앱이
 * 티로 전사에 손댈 수 있는 자리는 이제 여기뿐이다.
 *
 * 사용자 교정 이력(CorrectionMemory)은 여기 안 넣는다. 그건 사용자가 화면에서 직접
 * 타이핑한 것이라 환자 이름이 섞일 수 있다. 사전은 사람이 한 번 거른 목록이다.
 */
export async function autoPushTiroWords(apiKey: string): Promise<void> {
  const lexicon = await loadLexicon();
  const { words } = tiroWordsOf(lexicon);
  const pushed = new Set(await getSetting<string[]>(TIRO_PUSHED, []));
  const fresh = words.filter((w) => !pushed.has(w.entry));
  if (fresh.length === 0) return;

  try {
    for (let i = 0; i < fresh.length; i += TIRO_BULK) {
      const part = fresh.slice(i, i + TIRO_BULK);
      await pushTiroWordsBulk(apiKey, part);
      for (const w of part) pushed.add(w.entry);
    }
    await setSetting(TIRO_PUSHED, [...pushed]);
  } catch (e) {
    // 단어장은 전사의 곁다리다. 여기서 죽으면 전사 자체를 못 하게 되므로 삼킨다.
    // 올린 데까지는 남겨서 다음 전사 때 처음부터 다시 보내지 않는다.
    await setSetting(TIRO_PUSHED, [...pushed]);
    await logDebug(`티로 사전 자동 올리기 실패(가져오기는 계속): ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * 티로 연결 확인 — 열쇠가 맞는지, 쓸 워크스페이스가 있는지 한 번에 본다.
 *
 * 전사를 돌려 봐야만 알 수 있으면 진단이 너무 늦다. 이 버튼은 파일을 올리지
 * 않고 계정만 물어보므로 몇 초면 끝나고, 무엇이 문제인지 그 자리에서 말한다.
 */
/**
 * 열쇠가 맞는지, 그리고 **노트를 읽어 올 수 있는지** 확인한다.
 *
 * 앱은 티로에 파일을 올리지 않는다. 티로 앱으로 녹음한 노트의 글자를 읽어
 * 오는 것이 앱이 티로에 쓰는 전부다. 그래서 확인도 그것으로 한다 — 노트
 * 목록을 한 개만 받아 본다. (예전에는 빈 전사 작업을 만들어 봤는데, 그건
 * 이제 앱이 쓰지 않는 길이라 되든 말든 상관이 없다.)
 */
export async function checkTiroConnection(): Promise<{ ok: boolean; message: string }> {
  const key = await getTiroKey();
  if (!key) return { ok: false, message: "열쇠가 없어요. 위 칸에 넣고 저장해 주세요." };
  const headers = { authorization: `Bearer ${key}` };
  try {
    // 1) 열쇠가 맞는지 + 어느 워크스페이스인지.
    const me = await fetch(`${TIRO_API}/v1/external/workspaces/me`, { headers });
    if (me.status === 401) {
      return { ok: false, message: "열쇠가 맞지 않아요. 아이디.비밀문자 전체를 넣었는지 봐 주세요." };
    }
    if (me.status === 429) return { ok: false, message: "티로가 바빠요. 잠시 뒤 다시 눌러 주세요." };
    let guid = me.ok ? ((await me.json()) as { guid?: string }).guid : undefined;
    if (guid) await setSetting(TIRO_WORKSPACE_KEY, guid);
    else guid = await tiroWorkspaceGuid(key);
    if (!guid) {
      return {
        ok: false,
        message: "쓸 수 있는 워크스페이스가 없어요. 티로 홈페이지에서 하나 만들어 주세요.",
      };
    }

    // 2) 노트를 읽어 올 수 있는지 — 한 개만 받아 본다.
    //    워크스페이스 주소로 묻는다. `/v1/external/notes` 는 티로가 폐기 예정으로
    //    표시한 옛 주소다 (OpenAPI: deprecated).
    const probe = await fetch(
      `${TIRO_API}/v1/external/workspaces/${encodeURIComponent(guid)}/notes?size=1`,
      { headers },
    );
    if (!probe.ok) return { ok: false, message: await tiroError(probe, "연결 확인") };
    return { ok: true, message: "연결됐어요. 노트를 가져올 수 있어요." };
  } catch {
    return { ok: false, message: "티로에 닿지 못했어요. 인터넷 연결을 확인해 주세요." };
  }
}
