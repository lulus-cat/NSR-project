/**
 * 음성인식과 전사 후처리 파이프라인.
 *
 * 원리는 docs/02-transcription-pipeline.md에 정리되어 있다. 여기는 그 구현이다.
 *
 * 엔진 선택
 * --------
 * 전사는 **사용자가 지정한 서버**가 한다 — 콜랩 노트(무료 GPU)든 내 컴퓨터의
 * speaches 든, 같은 OpenAI 호환 API 로 붙는다. 온디바이스(whisper.cpp) 전사는
 * 접었다: 8시간 근무 기록을 폰이 삭이려면 몇 시간씩 걸리고 뜨거워지고,
 * 그 시간을 견딜 만큼 정확하지도 않았다.
 *
 * 상용 ASR API 는 여전히 없다. 병동 대화에는 환자 정보가 그대로 들어 있고,
 * 임의의 제3자 서비스에 그걸 올리는 경로는 이 앱이 제공하지 않는다.
 * (클로바 스피치를 잠깐 열었다가 요금이 오디오 길이 기준이라 접었다 — 근무
 * 통짜 기록에는 하루 만 원이 넘는다. 무료 경로들이 있는 한 정당화가 안 된다.)
 */

import {
  DEFAULT_ASR_OPTIONS,
  buildHotwords,
  buildInitialPrompt,
  buildLexicon,
  correctTranscript,
  splitAllIntoSentences,
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
  /** 이 엔진이 실제로 할 수 있는 것. 요청(AsrOptions)과 구분해서 본다. */
  readonly capabilities: AsrCapabilities;
  /** onProgress 는 0~100. 서버 전사는 작업 조회(폴링)가 준다. */
  transcribe(
    fileUri: string,
    options: AsrOptions,
    onProgress?: (pct: number) => void,
  ): Promise<AsrResult>;
}

/**
 * 사용자가 지정한 서버로 전사한다 (faster-whisper 등).
 *
 * 전송 전에 **오디오 자체는 비식별화할 수 없다.** 음성에는 이름과 진단이 그대로 담긴다.
 * 그래서 이 경로를 켜는 것은 사용자의 명시적 선택이어야 하고,
 * 켤 때 의료법 제19조를 다시 고지한다.
 */
export function createSelfHostedProvider(
  endpoint: string,
  apiKey?: string,
  model?: string,
): AsrProvider {
  // OpenAI 오디오 전사 표준(/v1/audio/transcriptions, verbose_json)으로 말한다.
  // 노트북에서 speaches(구 faster-whisper-server)·LocalAI 를 켜면 바로 붙는다.
  // 주소만 넣으면 경로를 붙여 주고, 전체 경로를 넣으면 그대로 쓴다.
  const url = /\/audio\/transcriptions\/?$/.test(endpoint)
    ? endpoint
    : `${endpoint.replace(/\/+$/, "")}/v1/audio/transcriptions`;
  return {
    id: `self-hosted:${endpoint}`,
    // OpenAI 전사 형식에는 화자 필드가 없다. 있다고 말하지 않는다.
    capabilities: { diarization: false, wordTimestamps: true },
    async transcribe(fileUri, options, onProgress) {
      // 파일 업로드는 fetch+FormData 가 아니라 네이티브 멀티파트로 한다.
      // SDK 57 부터 전역 fetch 가 새 구현(expo winter)인데, RN 구식
      // {uri,name,type} 파일 파트를 "Unsupported FormDataPart implementation"
      // 으로 거부한다 — 콜랩 첫 실사용에서 그대로 터진 오류다.
      // uploadAsync 는 디스크에서 스트리밍하므로 긴 조각을 메모리에
      // 통째로 올리지 않는 부수 이득도 있다.
      const FileSystem = await import("expo-file-system/legacy");
      const parameters: Record<string, string> = {
        language: options.language,
        temperature: String(options.temperature),
        response_format: "verbose_json",
      };
      if (model) parameters.model = model;
      if (options.initialPrompt) parameters.prompt = options.initialPrompt;

      const response = await FileSystem.uploadAsync(url, fileUri, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "file",
        mimeType: "audio/m4a",
        parameters,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      // 502/503/504 는 십중팔구 "터널은 있는데 서버(콜랩 세션)는 죽어 있음"이다.
      // 원시 상태 코드 대신 다음 행동을 말해 준다.
      const gatewayDown = (status: number): string | null =>
        status === 502 || status === 503 || status === 504
          ? `전사 서버가 응답하지 않습니다 (${status}). 콜랩 세션이 꺼진 것 같습니다 — 노트를 '모두 실행'으로 다시 켜고 새 주소를 넣어 주십시오.`
          : null;
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          gatewayDown(response.status) ??
            `전사 서버 오류 ${response.status}: ${response.body.slice(0, 300)}`,
        );
      }
      type ServerResult = {
        text?: string;
        duration?: number;
        segments?: { start: number; end: number; text: string; speaker?: string }[];
      };
      let json = JSON.parse(response.body) as ServerResult & { job_id?: string };

      // 접수증(job_id)을 주는 서버(콜랩 노트)는 결과를 몇 초마다 물어서 받는다.
      // 다 될 때까지 한 요청으로 기다리는 방식은 업로드 클라이언트(읽기 60초
      // 고정)와 Cloudflare 터널(응답 약 100초 상한)이 먼저 끊는다 — 실기기
      // 타임아웃으로 재현된 사실. 접수증이 없는 서버(speaches 등 동기 응답)는
      // 지금까지처럼 결과를 바로 쓴다.
      if (json.job_id) {
        const jobUrl = `${url}/${json.job_id}`;
        const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
        const deadline = Date.now() + 60 * 60 * 1000; // 한 시간이면 무엇이든 끝난다.
        // 502/503/504 한 방에 포기하지 않는다. Cloudflare 터널은 몇십 초씩
        // 출렁이곤 하는데, 작업은 서버에 살아 있다 — 실사용에서 전사가 100%
        // 까지 가 놓고 마지막 조회의 일시 오류로 통째로 버려진 사고가 있었다.
        // 3분을 넘겨 계속 죽어 있으면 그때 세션이 꺼진 것으로 판단한다.
        let gatewaySince: number | null = null;
        for (;;) {
          if (Date.now() > deadline) {
            throw new Error("전사 서버가 한 시간 안에 끝내지 못했습니다. 서버 상태를 확인하십시오.");
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          let poll: Response;
          try {
            poll = await fetch(jobUrl, { headers: authHeaders });
          } catch {
            continue; // 폰 네트워크가 잠깐 출렁여도 작업은 서버에 살아 있다.
          }
          if (poll.status === 502 || poll.status === 503 || poll.status === 504) {
            gatewaySince = gatewaySince ?? Date.now();
            if (Date.now() - gatewaySince < 3 * 60 * 1000) continue;
            throw new Error(gatewayDown(poll.status) ?? `전사 서버 오류 ${poll.status}`);
          }
          gatewaySince = null;
          if (poll.status === 404) {
            // 작업 목록은 콜랩 세션 메모리에 있다. 404 는 세션이 재시작됐다는 뜻.
            throw new Error(
              "전사 서버가 재시작되어 진행 중이던 작업이 사라졌습니다. " +
                "콜랩 노트를 '모두 실행'으로 다시 켜고 새 주소를 넣은 뒤, 전사를 다시 시작하십시오.",
            );
          }
          if (!poll.ok) {
            throw new Error(
              `전사 서버 오류 ${poll.status}: ${(await poll.text()).slice(0, 300)}`,
            );
          }
          const status = (await poll.json()) as {
            status?: string;
            progress?: number;
            error?: string;
            result?: ServerResult;
          };
          if (status.status === "error") {
            throw new Error(`전사 실패: ${status.error ?? "원인 미상"}`);
          }
          if (status.status === "done" && status.result) {
            json = status.result;
            break;
          }
          if (typeof status.progress === "number") {
            onProgress?.(Math.round(Math.max(0, Math.min(1, status.progress)) * 100));
          }
        }
      }
      const segments = (json.segments ?? []).map((s) => ({
        startSec: s.start,
        endSec: s.end,
        text: s.text.trim(),
        speakerId: s.speaker,
      }));
      // 서버가 세그먼트 없이 본문만 주면(짧은 파일에서 흔하다) 한 덩어리로 받는다.
      if (segments.length === 0 && json.text?.trim()) {
        segments.push({
          startSec: 0,
          endSec: json.duration ?? 0,
          text: json.text.trim(),
          speakerId: undefined,
        });
      }
      return { segments, durationSec: json.duration ?? 0 };
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
 * 기록 파일 하나를 전사하고 교정해 저장한다.
 * 근무 단위 산출물(카드·보고서·지표)은 `finalizeShift`에서 만든다.
 */
export async function processRecording(
  recording: RecordingRow,
  provider: AsrProvider,
  onProgress?: (pct: number) => void,
): Promise<number> {
  if (!recording.file_uri) return 0;

  await setRecordingState(recording.id, "transcribing");
  try {
    const lexicon = await loadLexicon();
    const options = await buildAsrOptions(lexicon);
    const asr = await provider.transcribe(recording.file_uri, options, onProgress);
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

/**
 * 현재 설정에 맞는 provider를 만든다.
 *
 * 전사 경로는 서버(콜랩 또는 내 컴퓨터)뿐이다. 주소가 없으면 전사를 시작할
 * 수 없고, 어디서 연결하는지까지 오류 문장이 말해 준다.
 */
export async function resolveProvider(): Promise<AsrProvider> {
  const cloud = await getSetting<{
    enabled: boolean;
    endpoint: string;
    apiKey?: string;
    model?: string;
  }>(SETTINGS_KEYS.cloudTranscription, { enabled: false, endpoint: "" });
  if (!cloud.endpoint) {
    throw new Error(
      "전사 서버가 연결되어 있지 않습니다. 설정 → 전사에서 콜랩(무료 GPU) 또는 내 컴퓨터를 연결하십시오.",
    );
  }
  return createSelfHostedProvider(cloud.endpoint, cloud.apiKey, cloud.model);
}
