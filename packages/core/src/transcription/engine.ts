/**
 * ASR 엔진 추상화.
 *
 * 어떤 엔진을 쓰느냐는 **개인정보 문제**이지 성능 문제만이 아니다.
 * 병동 대화에는 환자 이름·진단·처치가 그대로 들어 있다. 이걸 외부 서버로 보내면
 * 개인정보 보호법상 민감정보(건강정보)의 제3자 제공이 된다.
 *
 * 그래서 기본값은 **온디바이스**다. 정확도가 필요해 서버 전사를 쓰려면
 * 사용자가 명시적으로 켜야 하고, 그 전에 비식별화 단계를 거치도록 설계했다.
 *
 * 참고: docs/01-legal-and-privacy.md
 */

import type { Transcript } from "./types.js";

export type AsrEngineKind =
  /** 기기 안에서 whisper.cpp(ggml 양자화 모델)로 돌린다. 기본값. */
  | "on-device"
  /** 사용자가 직접 켠 경우에만. 비식별화 후 전송. */
  | "cloud";

export interface AsrOptions {
  /** 항상 "ko". 자동 감지에 맡기면 영어 약어 구간에서 언어가 흔들린다. */
  language: "ko";
  /**
   * 디코더 앞에 붙일 도메인 프롬프트. `buildInitialPrompt()`로 만든다.
   * 224 토큰 상한이 있으므로 길이를 넘기면 앞부분이 잘린다.
   */
  initialPrompt?: string;
  /** shallow fusion 방식의 편향 단어. faster-whisper 계열에서 지원. */
  hotwords?: string[];
  /**
   * 무음 구간 제거. 8시간 근무 녹음에서 실제 발화는 일부이므로
   * VAD를 켜면 전사 시간과 비용이 크게 줄고 환각도 준다.
   */
  vad: boolean;
  /** 화자분리. "누가 말했는가"는 태움 판단에 필수적이다. */
  diarize: boolean;
  /**
   * 0이면 결정적(greedy) 디코딩. 의료 전사에서는 창의성이 필요 없다.
   * 실패 시에만 온도를 올려 재시도하는 fallback을 엔진에 맡긴다.
   */
  temperature: number;
  /**
   * 반복 환각 억제 임계값. Whisper는 무음/잡음 구간에서 같은 문장을
   * 반복 생성하는 실패 모드가 있다. VAD와 함께 반드시 켠다.
   */
  suppressRepetition: boolean;
}

export const DEFAULT_ASR_OPTIONS: AsrOptions = {
  language: "ko",
  vad: true,
  diarize: true,
  temperature: 0,
  suppressRepetition: true,
};

export interface AsrRequest {
  /** 로컬 오디오 파일 경로/URI. */
  audioUri: string;
  /** 녹음 세션 id. 결과 Transcript에 그대로 실린다. */
  recordingId: string;
  startedAt: number;
  options: AsrOptions;
}

export interface AsrProgress {
  /** 0~1. */
  ratio: number;
  processedSec: number;
  totalSec: number;
}

export interface AsrProvider {
  readonly kind: AsrEngineKind;
  readonly id: string;
  transcribe(
    request: AsrRequest,
    onProgress?: (p: AsrProgress) => void,
  ): Promise<Transcript>;
}

/**
 * 개인정보 가리기는 `deidentify.ts`에 있다.
 * 전사 경로뿐 아니라 내보내기·공유·LLM 전송 어디서든 쓰이므로 따로 뒀다.
 */
export {
  deidentify,
  describeRedactions,
  checkBeforeExport,
  PII_LABELS,
  type PiiKind,
  type Redaction,
  type DeidentifyOptions,
  type DeidentifyResult,
  type ExportWarning,
} from "./deidentify.js";
