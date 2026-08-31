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
          return `앗 서버 놈이 대답을 안 해요 (${status}). 콜랩이 졸고 있는 듯? 노트 가서 '모두 실행' 눌러 깨우고 주소 쌔벼오세용`;
        }
        if (status >= 500) {
          return `서버로 가는 비밀 터널이 무너졌어요 (${status}). 콜랩 죽은 거 같으니 '모두 실행'으로 다시 살려내고 주소 따와요!`;
        }
        return null;
      };
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          gatewayDown(response.status) ??
            `서버 놈 뻘소리 시전 중 ${response.status}: ${response.body.slice(0, 300)}`,
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
        let lastFailure = "서버랑 멱살 놓침 뚝";

        // 죽음이 확정됐을 때: 받아 둔 것이 있으면 부분 회수, 없으면 그냥 실패.
        const giveUp = (reason: string): void => {
          if (collected.length === 0) throw new Error(reason);
          partialNote =
            `앗 서버 놈이 도망가서 약 ${Math.round(lastProgress * 100)}%까지만 간신히 살렸어요 ` +
            "남은 건 '변환 대기줄'에 모셔뒀으니, 서버 다시 패서 깨운 다음에 첨부터 다시 돌리면 됩니다! " +
            `(도망간 이유: ${reason})`;
          json = {
            segments: collected,
            duration: collected[collected.length - 1].end,
          };
        };

        poll_loop: for (;;) {
          if (Date.now() > deadline) {
            giveUp("서버 놈이 한 시간째 쩔쩔매고 있어요 ㅠㅠ 죽었나 살았나 한 번 찔러보세요");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          let poll: Response | null = null;
          try {
            poll = await fetch(`${jobUrl}?since=${sinceIndex}`, { headers: authHeaders });
          } catch {
            lastFailure = "앗 서버에 빨대가 안 꽂혀요 ㅠㅠ 폰 와이파이나 콜랩 살아있나 쳌쳌!";
          }
          if (poll && poll.status >= 500) {
            lastFailure = gatewayDown(poll.status) ?? `서버 놈 에러 뱉음 ${poll.status}`;
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
              "엥? 서버 놈이 혼자 재부팅해서 열심히 하던 거 싹 다 날려먹었어요 " +
                "심호흡 한 번 하고 콜랩 '모두 실행'으로 깨운 뒤, 새 주소 박고 다시 돌려요 우리...",
            );
            break;
          }
          if (!poll.ok) {
            throw new Error(
              `서버 놈이 뻘소리를 해요 ${poll.status}: ${(await poll.text()).slice(0, 300)}`,
            );
          }
          const status = (await poll.json()) as {
            status?: string;
            progress?: number;
            stage?: string;
            error?: string;
            result?: ServerResult;
            segments?: { start: number; end: number; text: string }[];
            next?: number;
          };
          switch (status.status) {
            case "error":
              throw new Error(`변환 엎어짐 대참사: ${status.error ?? "원인 모름 (귀신 곡할 노릇)"}`);
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
                ? "서버 놈이 몸 푸는 중이에요 (처음 한 번, 몇 분 걸림)"
                : status.stage === "align"
                  ? "단어마다 초시계 재서 줄 세우는 중"
                  : status.stage === "diarize"
                    ? "서버 놈이 목소리 갈라치기(화자 분리) 중 (몇 분 걸림)"
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
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/** 전용 전사 모델(gemini-3.5-transcribe 등)인가 — 호출 경로가 다르다. */
function isGeminiTranscribeModel(model: string): boolean {
  return /transcribe/i.test(model);
}

export function createGeminiProvider(apiKey: string, model: string): AsrProvider {
  return {
    id: `gemini:${model}`,
    // 일반 Gemini 는 화자 라벨만 주고 시각은 추정이다. 전용 전사 모델은
    // 단어 단위 실측 시각까지 준다.
    capabilities: { diarization: true, wordTimestamps: isGeminiTranscribeModel(model) },
    async transcribe(fileUri, options, onProgress) {
      const FileSystem = await import("expo-file-system/legacy");
      const info = await FileSystem.getInfoAsync(fileUri);
      const size = info.exists && "size" in info ? (info.size ?? 0) : 0;
      if (size <= 0) throw new Error("엥? 녹음 파일이 안 읽혀요 ㅠㅠ 고장 남");
      const mime = /\.wav$/i.test(fileUri) ? "audio/wav" : "audio/mp4";

      // 1) 재개형 업로드를 연다. 인라인(base64)은 20MB 상한이라 못 쓴다.
      onProgress?.(2, "구글 슨생님한테 파일 던지는 중");
      const start = await fetch(`${GEMINI_API.replace("/v1beta", "/upload/v1beta")}/files?key=${apiKey}`, {
        method: "POST",
        headers: {
          "x-goog-upload-protocol": "resumable",
          "x-goog-upload-command": "start",
          "x-goog-upload-header-content-length": String(size),
          "x-goog-upload-header-content-type": mime,
          "content-type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: `nsr-${Date.now()}` } }),
      });
      if (!start.ok) throw new Error(await geminiError(start, "업로드 슛 골인 대기 중"));
      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!uploadUrl) throw new Error("앗 구글 AI가 받을 주소를 안 줘요 (먹튀?)");

      // 2) 파일 본문을 올린다. 진행률은 여기(0~40%)가 대부분이다.
      const task = FileSystem.createUploadTask(
        uploadUrl,
        fileUri,
        {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            "content-length": String(size),
            "x-goog-upload-offset": "0",
            "x-goog-upload-command": "upload, finalize",
          },
        },
        (p) => {
          if (p.totalBytesExpectedToSend > 0) {
            const ratio = p.totalBytesSent / p.totalBytesExpectedToSend;
            onProgress?.(Math.round(2 + ratio * 38), "구글 슨생님한테 파일 던지는 중");
          }
        },
      );
      const uploaded = await task.uploadAsync();
      if (!uploaded || uploaded.status < 200 || uploaded.status >= 300) {
        throw new Error(`구글 업로드 폭망 ㅠㅠ (${uploaded?.status ?? "?"}).`);
      }
      const fileMeta = (JSON.parse(uploaded.body) as {
        file?: { name?: string; uri?: string; state?: string };
      }).file;
      if (!fileMeta?.uri || !fileMeta.name) throw new Error("구글 슨생님이 파일을 뱉어냈어요");

      try {
        // 3) 파일 처리 완료 대기.
        onProgress?.(45, "구글 슨생님이 요리 준비 중");
        let state = fileMeta.state ?? "PROCESSING";
        const stateDeadline = Date.now() + 5 * 60 * 1000;
        while (state === "PROCESSING") {
          if (Date.now() > stateDeadline) throw new Error("엥 구글 슨생님이 5분 넘게 파일만 쪼물딱거려요");
          await new Promise((r) => setTimeout(r, 2000));
          const check = await fetch(`${GEMINI_API}/${fileMeta.name}?key=${apiKey}`);
          if (!check.ok) throw new Error(await geminiError(check, "파일 안녕한지 찌르기"));
          state = ((await check.json()) as { state?: string }).state ?? "ACTIVE";
        }
        if (state !== "ACTIVE") throw new Error("구글 슨생님이 이 음성 파일을 못 씹겠대요 뱉음");

        // 4a) 전용 전사 모델 — Interactions API. 화자·단어 시각이 실측이다.
        if (isGeminiTranscribeModel(model)) {
          onProgress?.(55, "찐 전문 모델이 폭풍 받아적기 시전 중");
          const out = await geminiTranscribeInteraction({
            apiKey,
            model,
            fileUri: fileMeta.uri,
            mime,
            vocab: options.hotwords ?? [],
            onProgress,
          });
          onProgress?.(100);
          return out;
        }

        // 4) 전사 요청 — 구조화 출력(JSON 배열)으로 강제한다.
        onProgress?.(55, "구글 AI가 폭풍 타건 중 — 진행률 안 뜨고 몇 분 멍때리니까 냅두세요");
        const prompt =
          "이 음성은 한국 병원 병동의 근무 중 대화 기록이다. 전체를 한국어로 전사하라.\n" +
          "- 문장 단위로 나누고, 각 항목에 시작(start)·끝(end) 시각을 초 단위 숫자로 붙여라.\n" +
          '- 목소리가 다른 사람마다 화자 라벨(speaker)을 "S1", "S2" 식으로 일관되게 붙여라.\n' +
          "- 들리는 그대로 적어라. 요약하거나 문장을 다듬거나 빼놓지 마라.\n" +
          (options.initialPrompt ? `- 자주 나오는 용어: ${options.initialPrompt}\n` : "");
        const gen = await fetch(`${GEMINI_API}/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { file_data: { file_uri: fileMeta.uri, mime_type: mime } },
                  { text: prompt },
                ],
              },
            ],
            generationConfig: {
              temperature: options.temperature,
              response_mime_type: "application/json",
              response_schema: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    start: { type: "NUMBER" },
                    end: { type: "NUMBER" },
                    speaker: { type: "STRING" },
                    text: { type: "STRING" },
                  },
                  required: ["start", "end", "text"],
                },
              },
              max_output_tokens: 65536,
            },
          }),
        });
        if (!gen.ok) throw new Error(await geminiError(gen, "글자로 풀기"));
        const data = (await gen.json()) as {
          candidates?: {
            content?: { parts?: { text?: string }[] };
            finishReason?: string;
          }[];
        };
        const cand = data.candidates?.[0];
        const raw = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
        let parsed: { start: number; end: number; speaker?: string; text: string }[];
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          throw new Error(
            cand?.finishReason === "MAX_TOKENS"
              ? "녹음이 너무 길어서 구글 AI가 쓰다 지쳐 잘라먹었어요 30분씩 토막 쳐서 돌리거나 콜랩 형님 부르세요!"
              : "구글 AI가 뭐라는지 못 알아먹겠어요 ㅠㅠ 한 번 더 돌려볼까요?",
          );
        }
        const segments = parsed
          .filter((s) => s.text?.trim())
          .map((s) => ({
            startSec: Math.max(0, Number(s.start) || 0),
            endSec: Math.max(0, Number(s.end) || 0),
            text: s.text.trim(),
            speakerId: s.speaker?.trim() || undefined,
          }));
        if (segments.length === 0) throw new Error("엥 구글 AI가 글자로 바꾼 걸 안 돌려줘요 (먹튀 2차전)");
        onProgress?.(100);
        return { segments, durationSec: segments[segments.length - 1].endSec };
      } finally {
        // 올린 파일은 48시간 뒤 자동 삭제되지만, 병동 음성은 바로 지운다.
        try {
          await fetch(`${GEMINI_API}/${fileMeta.name}?key=${apiKey}`, { method: "DELETE" });
        } catch {
          // 삭제 실패는 결과에 영향이 없다 — 48시간 자동 삭제가 받쳐 준다.
        }
      }
    },
  };
}

/**
 * gemini-3.5-transcribe — 구글의 전용 전사 모델. generateContent 가 아니라
 * Interactions API 를 쓴다. 화자 분리와 단어 단위 시각이 **실측**으로 오는
 * 대신, 화자 분리를 켠 요청은 30분(끄면 1시간) 한도가 있다 — 화면에도 적었다.
 */
async function geminiTranscribeInteraction(input: {
  apiKey: string;
  model: string;
  fileUri: string;
  mime: string;
  vocab: string[];
  onProgress?: (pct: number, note?: string) => void;
}): Promise<{
  segments: { startSec: number; endSec: number; text: string; speakerId?: string }[];
  durationSec: number;
}> {
  const headers = { "content-type": "application/json", "x-goog-api-key": input.apiKey };
  const res = await fetch(`${GEMINI_API}/interactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.model,
      input: [{ type: "audio", uri: input.fileUri, mime_type: input.mime }],
      generation_config: {
        transcription_config: {
          language_codes: ["ko-KR"],
          // 사전 용어를 키워드 부스팅으로 넣는다. 문서 권장 상한(100개 내외)을 따른다.
          ...(input.vocab.length > 0 ? { custom_vocabulary: input.vocab.slice(0, 100) } : {}),
          mode: {
            type: "verbatim",
            diarization_mode: "speaker",
            timestamp_granularities: ["word"],
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 400 && /duration|length|too.?long|minute|hour/i.test(detail)) {
      throw new Error(
        "찐 전문 모델 체력(화자 분리 시 30분 조루)을 넘겨버린 짱 긴 녹음이에요! " +
          "30분 미만 짤짤이에만 쓰거나, 모델을 gemini-3.7-flash 놈으로 갈아끼우거나, 콜랩 형님 부르세용!",
      );
    }
    throw new Error(await geminiErrorText(res.status, detail, "찐 전문 전사"));
  }

  interface WordInfo {
    type?: string;
    text?: string;
    speaker?: string;
    start_offset?: string;
    end_offset?: string;
  }
  interface InteractionData {
    id?: string;
    status?: string;
    steps?: { content?: { type?: string; text?: string; annotations?: WordInfo[] }[] }[];
  }
  let data = (await res.json()) as InteractionData;

  // 긴 파일은 바로 안 끝날 수 있다 — 완료될 때까지 상태를 묻는다.
  const deadline = Date.now() + 20 * 60 * 1000;
  while (data.status && data.status !== "completed" && data.id) {
    if (data.status === "failed" || data.status === "cancelled") {
      throw new Error("구글 AI 전문 모델이 뻗었어요 ㅠㅠ 물 한잔 먹고 이따 다시 찔러보세요");
    }
    if (Date.now() > deadline) throw new Error("구글 AI 전문 모델이 20분 넘게 뻘짓하다 파업 선언");
    await new Promise((r) => setTimeout(r, 3000));
    const check = await fetch(`${GEMINI_API}/${data.id}`, { headers });
    if (!check.ok) throw new Error(await geminiError(check, "변환 안녕한지 찌르기"));
    data = (await check.json()) as InteractionData;
  }

  const contents = (data.steps ?? []).flatMap((s) => s.content ?? []);
  const words: WordInfo[] = contents
    .flatMap((c) => c.annotations ?? [])
    .filter((a) => (a.type ?? "word_info") === "word_info" && (a.text ?? "").trim());
  const sec = (v?: string) => Number.parseFloat((v ?? "0").replace(/s$/i, "")) || 0;

  if (words.length === 0) {
    // 시각 주석이 없으면 본문이라도 살린다 — 실패보다 낫다.
    const text = contents.map((c) => c.text ?? "").join(" ").trim();
    if (!text) throw new Error("구글 AI가 다 바꾼 글자를 안 돌려줘요 ㅠㅠ 먹튀!");
    return { segments: [{ startSec: 0, endSec: 0, text }], durationSec: 0 };
  }

  // 단어를 문장으로 묶는다: 화자가 바뀌거나, 1.2초 이상 쉬거나, 문장부호로
  // 끝났거나, 한 덩어리가 18초를 넘으면 끊는다.
  const segments: { startSec: number; endSec: number; text: string; speakerId?: string }[] = [];
  let buf: string[] = [];
  let segStart = sec(words[0].start_offset);
  let segEnd = segStart;
  let segSpeaker = words[0].speaker;
  const flush = () => {
    const text = buf.join(" ").trim();
    if (text) segments.push({ startSec: segStart, endSec: segEnd, text, speakerId: segSpeaker });
    buf = [];
  };
  for (const w of words) {
    const start = sec(w.start_offset);
    const end = sec(w.end_offset);
    const sentenceEnded = buf.length > 0 && /[.?!…]$/.test(buf[buf.length - 1]);
    if (
      buf.length > 0 &&
      (w.speaker !== segSpeaker || start - segEnd > 1.2 || sentenceEnded || end - segStart > 18)
    ) {
      flush();
      segStart = start;
      segSpeaker = w.speaker;
    }
    if (buf.length === 0) {
      segStart = start;
      segSpeaker = w.speaker;
    }
    buf.push((w.text ?? "").trim());
    segEnd = Math.max(segEnd, end);
  }
  flush();

  return { segments, durationSec: segments[segments.length - 1]?.endSec ?? 0 };
}

function geminiErrorText(status: number, detail: string, doing: string): string {
  if (status === 400 && detail.includes("API_KEY")) {
    return "구글 AI 열쇠(키)가 안 맞아요! 설정 → 텍스트 변환 가서 Gemini 키 짝퉁 아닌지 쳌쳌";
  }
  if (status === 429) {
    return "헐 구글 공짜 한도 털림! 쿨타임 차면 다시 하거나, 카드 긁거나, 콜랩 형님 부르세요!";
  }
  return `구글 AI 뻘짓 ${doing} 오류 ${status}: ${detail.slice(0, 200)}`;
}

async function geminiError(res: Response, doing: string): Promise<string> {
  const detail = await res.text().catch(() => "");
  return geminiErrorText(res.status, detail, doing);
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
  onProgress?: (pct: number, note?: string) => void,
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
        onProgress?.(100, `뱉어낸 글자 예쁘게 빚는 중 — ${i}/${sentences.length} 문장`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const sentence = sentences[i];
      const corrected = correctTranscript(sentence.text, { lexicon, memory });
      segments.push({ ...sentence, text: corrected.text });
      perSegment.push({ edits: corrected.edits, annotations: corrected.annotations });
    }

    onProgress?.(100, `다 쓴 글자 폰에 짱박는 중 (${segments.length} 문장)`);
    await saveSegments(recording.id, recording.shift_id, segments, perSegment);
    if (asr.partial) {
      // 부분 회수: 받은 데까지는 방금 저장했다. 던지면 아래 catch 가 상태를
      // 'recorded' 로 되돌려서, 부분 전사본은 화면에 보이고 기록은
      // '전사할 기록'에 남는다 — 다시 전사하면 같은 자리에 덮어써진다.
      throw new Error(asr.partial);
    }
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
    mode?: string;
    geminiModel?: string;
    diarize?: boolean;
  }>(SETTINGS_KEYS.cloudTranscription, { enabled: false, endpoint: "" });

  if (cloud.mode === "gemini") {
    const { getApiKey } = await import("./llm");
    const key = await getApiKey("gemini");
    if (!key) {
      throw new Error(
        "구글 AI 열쇠(키)가 없어요! 설정 → 필수 기능 가서 Gemini 카드에 열쇠 좀 꽂아주세용",
      );
    }
    // 2.5 계열은 2026 상반기에 폐기 예고됐다 — 옛 저장값도 현행 모델로 옮겨 쓴다.
    const { migrateRetiredModel } = await import("./llm");
    return createGeminiProvider(
      key,
      migrateRetiredModel(cloud.geminiModel?.trim() ?? "") || "gemini-3.7-flash",
    );
  }

  if (!cloud.endpoint) {
    throw new Error(
      "앗 일 시킬 녀석(서버)이 없어요! 설정 → 텍스트 변환 가서 콜랩, 내 PC, 구글 AI 중 한 놈 꼭 찍어주세요",
    );
  }
  const hfToken = cloud.diarize ? await getHfToken() : null;
  return createSelfHostedProvider(cloud.endpoint, cloud.apiKey, cloud.model, {
    diarize: cloud.diarize,
    hfToken,
  });
}
