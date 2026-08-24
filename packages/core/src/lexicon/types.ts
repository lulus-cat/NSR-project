/** 용어 분류. 학습카드 덱 구성과 전사 교정 우선순위에 함께 쓰인다. */
export type TermCategory =
  | "assessment" // 사정 / 활력징후 / 사정도구
  | "procedure" // 처치 / 술기
  | "device" // 기구 / 장비 / 라인
  | "medication" // 약물 / 투약
  | "lab" // 검사 / 진단검사
  | "condition" // 환자 상태 / 진단
  | "emergency" // 응급 상황
  | "documentation" // 기록 / 보고 / 서류
  | "workflow" // 업무 흐름 / 부서 운영
  | "role" // 직역 / 역할
  | "shift"; // 근무 / 듀티

export interface LexiconEntry {
  /** 안정적인 식별자. 학습카드/교정로그가 이 값을 참조한다. */
  id: string;
  /** 대표 표기. 한국어 현장 표기를 우선한다. */
  ko: string;
  /** 영문 정식 명칭. */
  en?: string;
  /** 영문 약어. 항상 대문자로 저장한다. */
  abbr?: string;
  /**
   * 별칭 - **사람이 실제로 그렇게 말하는** 표기만 넣는다.
   *  1) 현장 변이형 ("폴리", "폴리카테터", "썩션")
   *  2) 약어의 한글 읽기 ("브이에스", "디엔알")
   * 음성인식이 잘못 적는 표기는 여기가 아니라 `misheard`에 넣는다.
   */
  aliases: string[];
  /**
   * 음성인식이 이 용어를 잘못 받아적는 표기들.
   * aliases와 달리 **교정 대상**이다. `lexicon/misheard.ts`에서 주입된다.
   */
  misheard?: string[];
  category: TermCategory;
  /** 한 줄 정의. 학습카드 뒷면의 기본값이 된다. */
  definition: string;
  /** 은어/속어 여부. true면 공식 기록에 그대로 쓰면 안 된다. */
  informal?: boolean;
  /** 은어인 경우 공식 기록에 쓸 표준 표현. */
  formal?: string;
  /** 신규간호사가 자주 놓치는 포인트. 카드 힌트/보고서 주의사항으로 쓰인다. */
  pitfall?: string;
  /** 근거 출처 id (sources 레지스트리 키). */
  sources?: string[];
}

/** 사전 조회 결과. */
export interface LexiconHit {
  entry: LexiconEntry;
  /** 입력에서 실제로 매칭된 문자열. */
  surface: string;
  /**
   * 매칭 방식. 교정 신뢰도 산정과 "고칠 것인가 둘 것인가" 판단에 쓴다.
   *   exact      화자가 실제로 그렇게 말함 → 두고 주석만
   *   misheard   ASR이 잘못 적음         → 고침
   *   phonetic   발음이 가까움            → 신뢰도에 따라 고침
   *   initialism 한글 알파벳 읽기         → 표기 스타일에 따라 변환
   */
  via: "exact" | "misheard" | "phonetic" | "initialism";
  /** 0~1. exact는 항상 1. */
  confidence: number;
}
