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
 * 클라우드 전사 전 비식별화.
 *
 * 완벽한 비식별화는 불가능하다는 점을 분명히 해둔다. 한국어 이름은 형태가 다양하고
 * 문맥에 따라 일반명사와 겹친다. 여기서 하는 것은 **위험을 줄이는 것**이지
 * 안전을 보장하는 것이 아니다. 그래서 앱은 클라우드 전사를 기본값으로 두지 않는다.
 *
 * 처리 대상
 *  - 등록번호로 보이는 숫자열 (6자리 이상 연속 숫자)
 *  - 주민등록번호 형태
 *  - 전화번호 형태
 *  - "OOO님", "OOO씨", "OOO 환자" 앞의 2~4음절 한글 (호칭 앞 이름)
 */
export interface DeidentifyResult {
  text: string;
  /** 치환된 개수. UI에서 "N건 가림"으로 보여준다. */
  redactedCount: number;
}

const PATTERNS: { re: RegExp; token: string }[] = [
  { re: /\d{6}\s*[-]\s*\d{7}/g, token: "[주민번호]" },
  { re: /01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g, token: "[전화번호]" },
  { re: /\b\d{6,}\b/g, token: "[등록번호]" },
  { re: /[가-힣]{2,4}(?=\s*(?:님|씨|환자|할머니|할아버지|어머님|아버님))/g, token: "[이름]" },
];

export function deidentify(text: string): DeidentifyResult {
  let out = text;
  let count = 0;
  for (const { re, token } of PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return token;
    });
  }
  return { text: out, redactedCount: count };
}
