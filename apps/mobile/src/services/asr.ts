/**
 * 음성인식과 전사 후처리 파이프라인.
 *
 * 원리는 docs/02-transcription-pipeline.md에 정리되어 있다. 여기는 그 구현이다.
 *
 * 엔진 선택
 * --------
 * 기본은 **온디바이스**다. 병동 대화에는 환자 정보가 그대로 들어 있고,
 * 그걸 외부로 보내는 것은 의료법 제19조가 걸리는 행위다.
 *
 * "클라우드"라고 부르는 옵션도 **상용 ASR API가 아니라 사용자가 지정한 서버**다.
 * 대부분의 경우 본인이 띄운 faster-whisper 서버이거나 병원이 제공한 내부 서버다.
 * 임의의 제3자 서비스에 병동 녹음을 올리는 경로는 이 앱이 제공하지 않는다.
 */

import {
  DEFAULT_ASR_OPTIONS,
  buildHotwords,
  buildInitialPrompt,
  buildLexicon,
  correctTranscript,
  splitAllIntoSentences,
  DEFAULT_MODEL_ID,
  generateCards,
  buildShiftReport,
  reportToMarkdown,
  scoreShift,
  type AsrOptions,
  type AsrCapabilities,
  type Lexicon,
  type TranscriptSegment,
  type CardSourceSegment,
  type Edit,
  type TermAnnotation,
} from "@nsr/core";
import {
  enabledWardPacks,
  knownEntryIds,
  listSegments,
  listUserTerms,
  loadCorrectionMemory,
  saveCards,
  saveSegments,
  saveShiftReport,
  saveTaeumScore,
  setRecordingState,
  type RecordingRow,
} from "../db";
import { getSetting } from "../db";
import { SETTINGS_KEYS } from "./scheduler";
import { recordSpeedSample, resolveModelPath } from "./models";

/**
 * 어떤 모델을 쓰는지는 이제 **사용자가 고른다.** 목록과 판단 근거는
 * core 의 `transcription/models.ts` 에, 받고 지우는 일은 `services/models.ts` 에 있다.
 *
 * 여기 남은 것은 하나 — 아무것도 고르지 않았을 때의 출발점이다.
 *
 * **한국어 파인튜닝된 모델을 쓸 것.** 원본 Whisper 는 한국어에서 약하다.
 * 공개된 실측으로 whisper-small 의 한국어 CER 이 18% 수준인데,
 * 같은 크기를 한국어 데이터로 재학습하면 6% 대로 떨어진다.
 * 세 배 차이다 — 모델을 키우는 것보다 한국어로 학습시키는 쪽이 훨씬 크게 먹힌다.
 *
 * 자세한 근거: docs/03-asr-tooling-and-prior-art.md
 */
export { DEFAULT_MODEL_ID } from "@nsr/core";

export interface AsrResult {
  segments: {
    startSec: number;
    endSec: number;
    text: string;
    speakerId?: string;
    confidence?: number;
  }[];
  durationSec: number;
}

export interface AsrProvider {
  readonly id: string;
  readonly kind: "on-device" | "self-hosted";
  /** 이 엔진이 실제로 할 수 있는 것. 요청(AsrOptions)과 구분해서 본다. */
  readonly capabilities: AsrCapabilities;
  /** 어떤 모델로 돌리는가. 속도 실측을 이 id에 묶어 둔다. */
  readonly modelId?: string;
  /** 고른 모델이 없어 다른 것으로 대신 돌리는 중인가. 화면에서 알려야 한다. */
  readonly fellBack?: boolean;
  transcribe(fileUri: string, options: AsrOptions): Promise<AsrResult>;
}

/**
 * whisper.cpp 온디바이스 전사.
 *
 * 네이티브 모듈이 필요하므로 Expo Go에서는 동작하지 않는다. 개발 빌드가 필요하다.
 *   npx expo install whisper.rn && npx expo prebuild
 * 모델(ggml, 양자화)은 최초 실행 시 내려받아 기기에 보관한다.
 */
export function createOnDeviceProvider(
  modelPath: string,
  modelId: string,
  fellBack = false,
): AsrProvider {
  let context: {
    transcribe: (
      uri: string,
      opts: Record<string, unknown>,
    ) => { promise: Promise<{ segments?: { text: string; t0: number; t1: number }[] }> };
  } | null = null;

  return {
    id: "whisper.cpp",
    kind: "on-device",
    // whisper.cpp 는 화자를 나누지 못한다. Whisper 는 음성을 글자로 옮기는
    // 모델이지 목소리를 구별하는 모델이 아니다. 화자분리는 화자 임베딩을 뽑아
    // 군집화하는 별개의 모델(pyannote 등)이 하는 일이고, 그건 여기 없다.
    // 그래서 화면은 "직접 지정해 주세요" 라고 말해야 한다.
    capabilities: { diarization: false, wordTimestamps: true },
    modelId,
    fellBack,
    async transcribe(fileUri, options) {
      const startedAt = Date.now();
      if (!context) {
        // 선택적 네이티브 의존성이다. 모듈 이름을 변수로 두어 번들러와 타입체커가
        // 정적으로 해석하지 않게 한다 (설치되지 않은 환경에서도 빌드되어야 한다).
        const moduleName = "whisper.rn";
        let mod: { initWhisper?: (o: { filePath: string }) => Promise<typeof context> };
        try {
          mod = (await import(moduleName)) as never;
        } catch {
          throw new Error(
            "온디바이스 전사에는 whisper.rn 네이티브 모듈이 필요합니다. " +
              "`npx expo install whisper.rn` 실행 후 개발 빌드를 생성하십시오." +
              "설정에서 자체 서버 전사로 전환할 수도 있습니다.",
          );
        }
        if (!mod.initWhisper) throw new Error("whisper.rn 초기화 함수를 찾을 수 없습니다.");
        context = await mod.initWhisper({ filePath: modelPath });
      }

      const { promise } = context!.transcribe(fileUri, {
        language: options.language,
        // 디코더 앞 문맥. 도메인 용어의 사전확률을 올린다 (224토큰 상한).
        prompt: options.initialPrompt,
        // 의료 전사에 창의성은 필요 없다. 결정적 디코딩.
        temperature: options.temperature,
        // 무음 구간에서의 반복 환각을 막는다.
        maxLen: 0,
        tokenTimestamps: true,
      });
      const result = await promise;
      const segments = (result.segments ?? []).map((s) => ({
        // whisper.cpp의 t0/t1은 1/100초 단위다.
        startSec: s.t0 / 100,
        endSec: s.t1 / 100,
        text: s.text.trim(),
      }));
      const durationSec = segments.length > 0 ? segments[segments.length - 1].endSec : 0;

      // 이번에 걸린 시간을 남긴다. 다음부터 "이 모델이면 얼마나 걸리는지"를
      // 이 기기의 실측으로 말할 수 있다. 별도 벤치마크를 돌릴 이유가 없다.
      void recordSpeedSample({
        modelId,
        audioSeconds: durationSec,
        elapsedSeconds: (Date.now() - startedAt) / 1000,
      });

      return { segments, durationSec };
    },
  };
}

/**
 * 사용자가 지정한 서버로 전사한다 (faster-whisper 등).
 *
 * 전송 전에 **오디오 자체는 비식별화할 수 없다.** 음성에는 이름과 진단이 그대로 담긴다.
 * 그래서 이 경로를 켜는 것은 사용자의 명시적 선택이어야 하고,
 * 켤 때 의료법 제19조를 다시 고지한다.
 */
export function createSelfHostedProvider(endpoint: string, apiKey?: string): AsrProvider {
  return {
    id: `self-hosted:${endpoint}`,
    kind: "self-hosted",
    // WhisperX + pyannote 를 띄운 서버라면 화자를 나눠 준다. 서버가 speaker 를
    // 안 주면 결과에 안 실릴 뿐이라, 여기서는 가능한 것으로 둔다.
    capabilities: { diarization: true, wordTimestamps: true },
    async transcribe(fileUri, options) {
      const form = new FormData();
      form.append("file", {
        uri: fileUri,
        name: "audio.m4a",
        type: "audio/m4a",
      } as unknown as Blob);
      form.append("language", options.language);
      form.append("temperature", String(options.temperature));
      form.append("vad_filter", String(options.vad));
      if (options.initialPrompt) form.append("initial_prompt", options.initialPrompt);
      if (options.hotwords?.length) form.append("hotwords", options.hotwords.join(" "));

      const response = await fetch(endpoint, {
        method: "POST",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        body: form,
      });
      if (!response.ok) {
        throw new Error(`전사 서버 오류 ${response.status}: ${await response.text()}`);
      }
      const json = (await response.json()) as {
        segments?: { start: number; end: number; text: string; speaker?: string }[];
        duration?: number;
      };
      return {
        segments: (json.segments ?? []).map((s) => ({
          startSec: s.start,
          endSec: s.end,
          text: s.text.trim(),
          speakerId: s.speaker,
        })),
        durationSec: json.duration ?? 0,
      };
    },
  };
}

/**
 * 세 층을 합친 사전. 화면과 전사가 **같은 사전**을 봐야 한다.
 *
 *   내 사전 > 병동 사전 > 내장 사전
 *
 * 병동 사전을 여기서 함께 싣는 것이 핵심이다. 그래야 그 병동에서만 쓰는 말도
 * 전사 교정과 학습카드에 그대로 반영된다.
 */
export async function loadLexicon(): Promise<Lexicon> {
  const [userTerms, packs] = await Promise.all([listUserTerms(), enabledWardPacks()]);
  return buildLexicon({ userTerms, packs });
}

/** 이 근무에서 쓸 ASR 옵션. 사전과 사용 이력으로 프롬프트를 만든다. */
export async function buildAsrOptions(lexicon: Lexicon): Promise<AsrOptions> {
  const usageCounts = await getSetting<Record<string, number>>("lexicon.usageCounts", {});
  return {
    ...DEFAULT_ASR_OPTIONS,
    initialPrompt: buildInitialPrompt(lexicon, { usageCounts }),
    hotwords: buildHotwords(lexicon, { usageCounts }),
  };
}

/**
 * 녹음 파일 하나를 전사하고 교정해 저장한다.
 * 근무 단위 산출물(카드·보고서·지표)은 `finalizeShift`에서 만든다.
 */
export async function processRecording(
  recording: RecordingRow,
  provider: AsrProvider,
): Promise<number> {
  if (!recording.file_uri) return 0;

  await setRecordingState(recording.id, "transcribing");
  try {
    const lexicon = await loadLexicon();
    const options = await buildAsrOptions(lexicon);
    const asr = await provider.transcribe(recording.file_uri, options);
    const memory = await loadCorrectionMemory();

    // 1) ASR 덩어리를 문장으로 편다.
    //
    //    Whisper 가 주는 것은 30초짜리 덩어리이지 문장이 아니다. 문장으로 나눠야
    //    화자를 문장별로 지정하고, 한 문장만 골라 고치고, 카드 예문이 문단째로
    //    들어가지 않는다. **교정보다 먼저** 나눠야 교정 위치가 문장 기준으로 잡힌다.
    const rawSegments: TranscriptSegment[] = asr.segments.map((s, i) => ({
      id: `${recording.id}#s${i}`,
      startSec: s.startSec,
      endSec: s.endSec,
      rawText: s.text,
      text: s.text,
      speakerId: s.speakerId,
      asrConfidence: s.confidence,
    }));
    const sentences = splitAllIntoSentences(rawSegments);

    // 2) 문장마다 교정한다.
    const segments: TranscriptSegment[] = [];
    const perSegment: { edits: Edit[]; annotations: TermAnnotation[] }[] = [];

    for (const sentence of sentences) {
      const corrected = correctTranscript(sentence.text, { lexicon, memory });
      segments.push({ ...sentence, text: corrected.text });
      perSegment.push({ edits: corrected.edits, annotations: corrected.annotations });
    }

    await saveSegments(recording.id, recording.shift_id, segments, perSegment);
    await setRecordingState(recording.id, "transcribed");
    return segments.length;
  } catch (error) {
    await setRecordingState(recording.id, "recorded");
    throw error;
  }
}

/**
 * 근무가 끝난 뒤 한 번 돌린다.
 * 전사본 전체를 모아 학습카드·태움 지표·보고서를 만든다.
 */
export async function finalizeShift(input: {
  shiftId: string;
  date: string;
  dutyLabel: string;
  recordedSec: number;
  now?: number;
}): Promise<{ cardsAdded: number; taeumScore: number }> {
  const now = input.now ?? Date.now();
  const lexicon = await loadLexicon();
  const segments = await listSegments(input.shiftId);
  const known = await knownEntryIds();

  // 세그먼트 본문을 다시 교정 파이프라인에 통과시켜 주석을 얻는다.
  // (DB의 annotations를 읽어도 되지만, 사용자가 본문을 직접 고쳤을 수 있어 재계산이 안전하다.)
  const cardSegments: CardSourceSegment[] = [];
  const termIds: string[] = [];
  for (const seg of segments) {
    const corrected = correctTranscript(seg.text, { lexicon });
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

/** 현재 설정에 맞는 provider를 만든다. */
export async function resolveProvider(): Promise<AsrProvider> {
  const cloud = await getSetting<{ enabled: boolean; endpoint: string; apiKey?: string }>(
    SETTINGS_KEYS.cloudTranscription,
    { enabled: false, endpoint: "" },
  );
  if (cloud.enabled && cloud.endpoint) {
    return createSelfHostedProvider(cloud.endpoint, cloud.apiKey);
  }
  const { path, model, fellBack } = await resolveModelPath();
  if (!path) {
    throw new Error(
      "전사 모델이 없습니다. 설정 → 전사 모델에서 다운로드하십시오.",
    );
  }
  return createOnDeviceProvider(path, model?.id ?? DEFAULT_MODEL_ID, fellBack);
}
