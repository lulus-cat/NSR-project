/** 화자 역할. 화자분리(diarization) 결과에 사람이 라벨을 붙인 것. */
export type SpeakerRole =
  | "self" // 본인(신규간호사)
  | "senior" // 선배/프리셉터
  | "doctor" // 의사
  | "patient" // 환자
  | "guardian" // 보호자
  | "other"
  | "unknown";

export interface TranscriptSegment {
  /** 세그먼트 id. 녹음 파일 내에서 유일. */
  id: string;
  /** 녹음 시작 기준 초 단위 시각. */
  startSec: number;
  endSec: number;
  /** ASR이 뱉은 원문. 절대 덮어쓰지 않는다. */
  rawText: string;
  /** 교정 파이프라인을 거친 본문. 교정 전에는 rawText와 같다. */
  text: string;
  /** 화자 클러스터 id (예: "spk_0"). diarization 미수행 시 undefined. */
  speakerId?: string;
  /** 사용자가 지정한 화자 역할. */
  speakerRole?: SpeakerRole;
  /** ASR 자체 신뢰도(0~1). 모델이 제공하는 경우에만. */
  asrConfidence?: number;
}

export interface Transcript {
  /** 녹음 세션 id. */
  recordingId: string;
  /** 녹음 시작 시각 (epoch ms). */
  startedAt: number;
  /** 전체 길이(초). */
  durationSec: number;
  segments: TranscriptSegment[];
  /** 사용한 ASR 엔진 식별자 (예: "whisper-large-v3", "on-device-whisper.cpp-small"). */
  engine?: string;
  /** 근무 id (듀티표 연결). */
  shiftId?: string;
}

/** 교정 한 건. UI에서 개별 수락/거절이 가능해야 하므로 편집 단위로 남긴다. */
export interface Edit {
  /** 교정 후 텍스트 기준 위치. */
  start: number;
  end: number;
  /** 원래 표기. */
  from: string;
  /** 바꾼 표기. */
  to: string;
  reason: "initialism" | "misheard" | "phonetic" | "learned";
  entryId?: string;
  /** 0~1. 낮으면 UI에서 회색으로 표시해 사용자 확인을 유도한다. */
  confidence: number;
}

/** 본문에서 사전 용어로 인식된 구간. 툴팁/카드 생성의 앵커. */
export interface TermAnnotation {
  start: number;
  end: number;
  surface: string;
  entryId: string;
  via: "exact" | "misheard" | "phonetic" | "initialism";
  confidence: number;
}

export interface CorrectionResult {
  original: string;
  text: string;
  edits: Edit[];
  annotations: TermAnnotation[];
  /** 이 전사에 등장한 용어 id 목록(중복 제거, 등장 순). */
  termIds: string[];
}
