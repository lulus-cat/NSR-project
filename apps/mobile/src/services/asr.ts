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
  collapseRepeatedSentences,
  correctTranscript,
  splitAllIntoSentences,
  generateCards,
  buildShiftReport,
  reportToMarkdown,
  scoreShift,
  type TaeumScore,
  type AsrOptions,
  type AsrCapabilities,
  type Lexicon,
  type TranscriptSegment,
  type CardSourceSegment,
  type Edit,
  type TermAnnotation,
  DEFAULT_COLAB_MODEL_ID,
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
import { getSetting, setSetting } from "../db";
import { SETTINGS_KEYS } from "./scheduler";
import { logDebug } from "./debug";

export interface AsrResult {
  segments: {
    startSec: number;
    endSec: number;
    text: string;
    speakerId?: string;
    confidence?: number;
  }[];
  durationSec: number;
  /**
   * 서버가 끝까지 못 가고 죽었지만 받은 데까지는 건진 경우의 안내문.
   * 이 값이 있으면 전사본은 저장하되 기록은 '전사할 기록'에 남겨야 한다.
   */
  partial?: string;
}

export interface AsrProvider {
  readonly id: string;
  /** 이 엔진이 실제로 할 수 있는 것. 요청(AsrOptions)과 구분해서 본다. */
  readonly capabilities: AsrCapabilities;
  /** onProgress 는 0~100. note 는 %가 안 움직이는 이유(모델 준비 중 등). */
  transcribe(
    fileUri: string,
    options: AsrOptions,
    onProgress?: (pct: number, note?: string) => void,
  ): Promise<AsrResult>;
}

/**
 * 허깅페이스 토큰 — 화자 분리(pyannote)용.
 *
 * pyannote 모델은 무료·공개지만 허깅페이스가 문을 잠가 두어(게이트), 받으려면
 * 사용자 본인의 토큰이 필요하다. 토큰은 기기 보안 저장소에만 두고, 전사
 * 요청에 실려 **사용자가 띄운 콜랩 서버로만** 간다. 설정 DB·로그에 안 남긴다.
 */
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

const HF_TOKEN_KEY = "nsr.hf.token";

export async function getHfToken(): Promise<string | null> {
  const SecureStore = await import("expo-secure-store");
  return SecureStore.getItemAsync(HF_TOKEN_KEY);
}

export async function setHfToken(token: string | null): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  if (token && token.trim()) {
    await SecureStore.setItemAsync(HF_TOKEN_KEY, token.trim(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(HF_TOKEN_KEY);
  }
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
  extras?: { diarize?: boolean; hfToken?: string | null },
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
      // 화자 분리 — 콜랩 노트만 이해한다. 다른 서버는 모르는 필드를 무시한다.
      // 토큰은 보통 콜랩 '보안 비밀'(HF_TOKEN)에 있으므로 켜짐 신호만 보낸다.
      // 기기에 남아 있는 옛 토큰이 있으면 예비로 함께 싣는다.
      if (extras?.diarize) {
        parameters.diarize = "1";
        if (extras.hfToken) parameters.hf_token = extras.hfToken;
      }

      const response = await FileSystem.uploadAsync(url, fileUri, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "file",
        mimeType: "audio/m4a",
        parameters,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      // 5xx 는 "폰도 터널도 멀쩡한데 그 너머가 죽어 있음"이다. 원시 상태
      // 코드 대신 다음 행동을 말해 준다. 502/503/504 는 터널 뒤 서버가 죽은
      // 것, 530(등 Cloudflare 계열)은 터널 자체가 사라진 것 — 콜랩 세션이
      // 회수되면 cloudflared 도 죽어서 Cloudflare 가장자리가 530 을 준다.
      // 지난번 "재연결하니 취소됐다" 사고의 정체가 이 530 이었다.
      const gatewayDown = (status: number): string | null => {
        if (status === 502 || status === 503 || status === 504) {
          return "서버가 답하지 않아요. 콜랩에서 '모두 실행'을 누르고 주소를 다시 넣어 주세요.";
        }
        if (status >= 500) {
          return "연결이 끊겼어요. 콜랩에서 '모두 실행'을 누르고 주소를 다시 넣어 주세요.";
        }
        return null;
      };
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          gatewayDown(response.status) ??
            `글자로 바꾸지 못했어요 (${response.status}). 연결을 확인하고 다시 해 주세요.`,
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
      let partialNote: string | undefined;
      if (json.job_id) {
        const jobUrl = `${url}/${json.job_id}`;
        const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
        const deadline = Date.now() + 60 * 60 * 1000; // 한 시간이면 무엇이든 끝난다.

        // 세그먼트를 되는 족족 받아 둔다(?since 증분). 결과가 서버 메모리에만
        // 있으면 세션이 회수되는 순간 100% 전사도 통째로 사라진다 — 실사용
        // 사고다. 받아 둔 것이 있으면 서버가 죽어도 그만큼은 건진다.
        const collected: NonNullable<ServerResult["segments"]> = [];
        let sinceIndex = 0;
        let lastProgress = 0;

        // 일시 오류 한 방에 포기하지 않는다. Cloudflare 터널은 몇십 초씩
        // 출렁이고, 그동안 작업은 서버에 살아 있다. 폰 네트워크 단절이든
        // 5xx 든 한 바구니로 재고, 3분을 넘기면 그때 죽은 것으로 판단한다.
        let outageSince: number | null = null;
        let lastFailure = "연결이 끊겼어요. 인터넷을 확인해 주세요.";

        // 죽음이 확정됐을 때: 받아 둔 것이 있으면 부분 회수, 없으면 그냥 실패.
        const giveUp = (reason: string): void => {
          if (collected.length === 0) throw new Error(reason);
          partialNote =
            `연결이 끊겨서 ${Math.round(lastProgress * 100)}% 까지만 건졌어요. ` +
            "남은 녹음은 그대로 있어요. 다시 이은 뒤에 한 번 더 눌러 주세요. " +
            `(도망간 이유: ${reason})`;
          json = {
            segments: collected,
            duration: collected[collected.length - 1].end,
          };
        };

        poll_loop: for (;;) {
          if (Date.now() > deadline) {
            giveUp("한 시간 넘게 끝나지 않았어요. 연결을 확인하고 다시 해 주세요.");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          let poll: Response | null = null;
          try {
            poll = await fetch(`${jobUrl}?since=${sinceIndex}`, { headers: authHeaders });
          } catch {
            lastFailure = "연결하지 못했어요. Wi-Fi 와 콜랩이 켜져 있는지 확인해 주세요.";
          }
          if (poll && poll.status >= 500) {
            lastFailure = gatewayDown(poll.status) ?? `서버가 답하지 못했어요 (${poll.status}).`;
            poll = null;
          }
          if (!poll) {
            outageSince = outageSince ?? Date.now();
            if (Date.now() - outageSince < 3 * 60 * 1000) continue;
            giveUp(lastFailure);
            break;
          }
          outageSince = null;
          if (poll.status === 404) {
            // 작업 목록은 콜랩 세션 메모리에 있다. 404 는 세션이 재시작됐다는 뜻.
            giveUp(
              "콜랩이 다시 켜지면서 하던 일이 사라졌어요. " +
                "콜랩을 '모두 실행'으로 켜고 새 주소를 넣은 뒤 다시 해 주세요.",
            );
            break;
          }
          if (!poll.ok) {
            throw new Error(
              `서버 답을 읽지 못했어요 (${poll.status}). 다시 해 주세요.`,
            );
          }
          const status = (await poll.json()) as {
            status?: string;
            progress?: number;
            stage?: string;
            error?: string;
            /** 서버가 실제로 실은 모델 — 고른 것과 다른지 여기서 드러난다. */
            model?: string;
            result?: ServerResult;
            segments?: { start: number; end: number; text: string }[];
            next?: number;
          };
          switch (status.status) {
            case "error":
              throw new Error(`글자로 바꾸지 못했어요: ${status.error ?? "원인을 알 수 없어요"}`);
            case "done":
              if (status.result) {
                json = status.result;
                break poll_loop;
              }
              break;
            default:
              break;
          }
          if (Array.isArray(status.segments) && status.segments.length > 0) {
            collected.push(...status.segments);
          }
          sinceIndex = status.next ?? collected.length;
          if (typeof status.progress === "number") {
            lastProgress = Math.max(0, Math.min(1, status.progress));
            onProgress?.(
              Math.round(lastProgress * 100),
              // %가 안 움직이는 구간의 이유를 말해 준다 — 모델 준비와 화자 분리.
              status.stage === "model"
                ? `${status.model ?? "모델"} 준비하는 중`
                : status.stage === "transcribe"
                  ? "받아적는 중"
                  : status.stage === "align"
                    ? "단어마다 시각 맞추는 중"
                    : status.stage === "diarize"
                      ? "목소리 나누는 중"
                      : undefined,
            );
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
      return { segments, durationSec: json.duration ?? 0, partial: partialNote };
    },
  };
}

/**
 * 구글 Gemini 직접 전사 — 서버도 노트도 없이 API 키 하나로.
 *
 * 휘스퍼 경로(콜랩·PC)와는 완전히 다른 물건이다: 전용 전사 모델이 아니라
 * 멀티모달 LLM 에 음성을 통째로 주고 구조화된 전사(JSON)를 받아 낸다.
 * 화자 라벨까지 같이 붙여 주는 대신, **시각은 모델의 추정치**라 재생 위치가
 * 몇 초씩 어긋날 수 있다 — 화면에도 그렇게 적는다.
 *
 * 개인정보에 대해 정직하게: 기록 음성이 구글 Gemini 서버로 간다. 특히
 * **무료 티어는 입력이 구글의 모델 개선에 쓰일 수 있다** — 병동 음성이면
 * 유료(청구 연결) 계정을 권한다. 설정 화면이 이 말을 그대로 한다.
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
/**
 * ASR 이 준 덩어리를 문장으로 펴고, 교정하고, 저장한다.
 *
 * 전사 엔진이 무엇이든(서버 휘스퍼·제미나이·티로) 여기서부터는 같다. 티로 노트
 * 가져오기처럼 **파일 없이 전사본만 들어오는 길**도 이 함수를 탄다 — 교정 규칙과
 * 문장 나누기가 한 곳에만 있어야 결과가 갈리지 않는다.
 */
export async function saveAsrSegments(input: {
  recordingId: string;
  shiftId: string | null;
  segments: AsrResult["segments"];
  /** 오인식 목록을 들이댈지. 휘스퍼 전사본에만 맞는다. */
  asrEngine: "whisper" | "other";
  onProgress?: (pct: number, note?: string) => void;
}): Promise<number> {
  const lexicon = await loadLexicon();
  const memory = await loadCorrectionMemory();

  // 1) ASR 덩어리를 문장으로 편다.
  //
  //    Whisper 가 주는 것은 30초짜리 덩어리이지 문장이 아니다. 문장으로 나눠야
  //    화자를 문장별로 지정하고, 한 문장만 골라 고치고, 카드 예문이 문단째로
  //    들어가지 않는다. **교정보다 먼저** 나눠야 교정 위치가 문장 기준으로 잡힌다.
  const rawSegments: TranscriptSegment[] = input.segments.map((s, i) => ({
    id: `${input.recordingId}#s${i}`,
    startSec: s.startSec,
    endSec: s.endSec,
    rawText: s.text,
    text: s.text,
    speakerId: s.speakerId,
    asrConfidence: s.confidence,
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
    const corrected = correctTranscript(sentence.text, {
      lexicon,
      memory,
      asrEngine: input.asrEngine,
    });
    segments.push({ ...sentence, text: corrected.text });
    perSegment.push({ edits: corrected.edits, annotations: corrected.annotations });
  }

  input.onProgress?.(100, `폰에 저장하는 중 (${segments.length}문장)`);
  await saveSegments(input.recordingId, input.shiftId, segments, perSegment);
  return segments.length;
}

/**
 * 기록 파일 하나를 전사하고 교정해 저장한다.
 * 근무 단위 산출물(카드·보고서·지표)은 `finalizeShift`에서 만든다.
 */
export async function processRecording(
  recording: RecordingRow,
  provider: AsrProvider,
  onProgress?: (pct: number, note?: string) => void,
): Promise<number> {
  if (!recording.file_uri) return 0;

  await setRecordingState(recording.id, "transcribing");
  try {
    const lexicon = await loadLexicon();
    const options = await buildAsrOptions(lexicon);
    const asr = await provider.transcribe(recording.file_uri, options, onProgress);
    // 오인식 목록은 **휘스퍼가** 어떻게 틀리는지의 기록이다. 제미나이·티로 전사본에
    // 들이대면 맞지도 않고 엉뚱한 말을 바꾼다 (@nsr/core CorrectionOptions.asrEngine).
    // 휘스퍼로 도는 것은 서버 경로(콜랩·내 PC)뿐이라, 그것만 "whisper" 로 본다.
    const asrEngine = provider.id.startsWith("self-hosted:")
      ? ("whisper" as const)
      : ("other" as const);

    const count = await saveAsrSegments({
      recordingId: recording.id,
      shiftId: recording.shift_id,
      segments: asr.segments,
      asrEngine,
      onProgress,
    });

    if (asr.partial) {
      // 부분 회수: 받은 데까지는 방금 저장했다. 던지면 아래 catch 가 상태를
      // 'recorded' 로 되돌려서, 부분 전사본은 화면에 보이고 기록은
      // '전사할 기록'에 남는다 — 다시 전사하면 같은 자리에 덮어써진다.
      throw new Error(asr.partial);
    }
    await setRecordingState(recording.id, "transcribed");
    return count;
  } catch (error) {
    await setRecordingState(recording.id, "recorded");
    throw error;
  }
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
  const segments = await listSegments(shiftId);
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
  const segments = await listSegments(input.shiftId);
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

/**
 * 현재 설정에 맞는 provider를 만든다.
 *
 * 전사 경로는 서버(콜랩 또는 내 컴퓨터)뿐이다. 주소가 없으면 전사를 시작할
 * 수 없고, 어디서 연결하는지까지 오류 문장이 말해 준다.
 *
 * 티로는 여기 없다. 티로에 파일을 올리는 길(Voice File Job)은 워크스페이스마다
 * 티로가 켜 줘야 열리는데, 이 계정에는 안 켜져 있다. 그래서 앱이 티로에 하는
 * 일은 두 가지뿐이다 — **녹음**과 **티로가 이미 받아적어 둔 글자 가져오기**
 * (`tiro-notes.ts`). 올리기 경로는 0.1.8x 에서 지웠다.
 */
/** 저장된 설정의 전사 방식. 콜랩 연결 화면(connect.tsx)이 넣어 주는 값이다. */
function inferAsrMode(cloud: { mode?: string; endpoint?: string }): string {
  if (cloud.mode) return cloud.mode;
  if (cloud.endpoint && !cloud.endpoint.includes("trycloudflare.com")) return "pc";
  return "colab";
}

export async function resolveProvider(): Promise<AsrProvider> {
  const cloud = await getSetting<{
    enabled: boolean;
    endpoint: string;
    apiKey?: string;
    model?: string;
    mode?: string;
    geminiModel?: string;
    diarize?: boolean;
  }>(SETTINGS_KEYS.cloudTranscription, { enabled: false, endpoint: "" });

  if (!cloud.endpoint) {
    throw new Error(
      "글자로 바꿀 곳이 없어요. 콜랩을 잇거나 티로 노트에서 가져와 주세요.",
    );
  }
  const hfToken = cloud.diarize ? await getHfToken() : null;
  // 콜랩은 '서버 기본값' 선택지가 없다 — 화면에 기본 모델이 선택된 것으로 보이는
  // 만큼, 아무것도 안 보내지 말고 그 id 를 실어 보낸다. 예전에는 안 보내서
  // 서버 기본값이 쓰였고, 화면이 말하는 모델과 실제 모델이 달랐다.
  const model =
    cloud.model?.trim() ||
    (inferAsrMode(cloud) === "colab" ? DEFAULT_COLAB_MODEL_ID : undefined);
  return createSelfHostedProvider(cloud.endpoint, cloud.apiKey, model, {
    diarize: cloud.diarize,
    hfToken,
  });
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

/** 사전에서 티로에 올릴 수 있는 말만 고른다. entry 는 1~63자·공백 불가다. */
function tiroWordsOf(lexicon: Lexicon): { words: { entry: string; subEntry?: string }[]; skipped: number } {
  const ok = (w?: string) => !!w && w.length <= 63 && !/\s/.test(w);
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
    const probe = await fetch(`${TIRO_API}/v1/external/notes?size=1`, { headers });
    if (!probe.ok) return { ok: false, message: await tiroError(probe, "연결 확인") };
    return { ok: true, message: "연결됐어요. 노트를 가져올 수 있어요." };
  } catch {
    return { ok: false, message: "티로에 닿지 못했어요. 인터넷 연결을 확인해 주세요." };
  }
}
