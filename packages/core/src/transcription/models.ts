/**
 * 전사 서버 모델 카탈로그.
 *
 * 전사는 폰에서 하지 않는다
 * ----------------------
 * 온디바이스 전사(whisper.cpp)는 접었다. 8시간 근무 기록을 폰이 삭이려면
 * 몇 시간씩 걸리고 뜨거워지고, 그 시간을 견딜 만큼 정확하지도 않았다.
 * 지금 경로는 둘뿐이다 — **구글 콜랩(무료 GPU)** 과 **내 컴퓨터(PC·노트북)**.
 * 둘 다 같은 OpenAI 호환 API 로 붙고, 어떤 모델로 돌릴지는 여기 목록에서
 * 사용자가 고른다. 앱이 요청에 model 파라미터로 실어 보낸다.
 *
 * 크기보다 한국어가 먼저다
 * ----------------------
 * 공개된 실측에서 whisper-small 원본의 한국어 CER 이 18.05%인데,
 * 같은 크기를 한국어로 재학습하면 6.45%로 떨어진다. 세 배 차이다.
 * 목록에서 한국어 파인튜닝 모델을 위에 두는 이유다.
 *
 * summary 규칙: **한 문장.** 한국어 정확도(실측이 있으면 숫자, 없으면
 * 학습 데이터)와 특징을 그 한 문장에 담는다. 실측이 없는 모델에
 * 숫자를 지어내지 않는다 — 적어 두면 사용자가 사실로 받아들인다.
 */

export interface ServerAsrModel {
  /**
   * 서버에 model 파라미터로 보내는 값.
   * 허깅페이스 CT2 저장소 id, 또는 우리 릴리스 미러를 뜻하는 "nsr-korean-medium".
   */
  id: string;
  name: string;
  /** 화면에 보이는 전부 — 한국어 정확도와 특징을 담은 한 문장. */
  summary: string;
  /**
   * 어디서 쓸 수 있는가.
   * "colab": 우리 콜랩 노트 전용(깃허브 릴리스 미러라서 허깅페이스에 없다).
   * "any": 허깅페이스 공개 저장소라 콜랩·speaches 등 어디서든 받아진다.
   */
  where: "colab" | "any";
  /** 대략의 내려받기 크기(GB). 서버가 받는 것이지 폰이 받는 게 아니다. */
  approxGb: number;
}

/**
 * 다섯 항목 전부 2026-08 러너 조사로 실존·파일 구성을 확인했다.
 * (지난 401 사고의 원인이 기억으로 적은 유령 저장소였다 — 같은 실수를 반복하지 않는다.)
 */
export const SERVER_MODELS: ServerAsrModel[] = [
  {
    id: "nsr-korean-medium",
    name: "NSR 한국어 Medium (대화 특화)",
    summary:
      "한국어 대화 1,273시간(소음 섞인 대화 363시간 포함)으로 재학습되어 병동 대화체에 가장 강합니다.",
    where: "colab",
    approxGb: 1.5,
  },
  {
    id: "ghost613/faster-whisper-large-v3-turbo-korean",
    name: "한국어 Large v3 Turbo",
    summary:
      "한국어 낭독 음성으로 재학습된 대형 모델이라 또렷한 발음에 강하지만, 대화체 정확도 실측은 공개돼 있지 않습니다.",
    where: "any",
    approxGb: 3.2,
  },
  {
    id: "deepdml/faster-whisper-large-v3-turbo-ct2",
    name: "다국어 Large v3 Turbo",
    summary:
      "한국어 전용 학습은 없지만 빠르고 메모리가 안전해 무료 콜랩에서 끊김 없이 돌기 좋습니다.",
    where: "any",
    approxGb: 1.6,
  },
  {
    id: "Systran/faster-whisper-large-v3",
    name: "다국어 Large v3",
    summary:
      "원본 중 한국어가 가장 정확(공개 벤치마크 CER 8~12%)하지만 가장 크고 느립니다.",
    where: "any",
    approxGb: 3.0,
  },
  {
    id: "Systran/faster-whisper-medium",
    name: "다국어 Medium",
    summary:
      "가볍고 빨라 급할 때 좋지만, 한국어 원본 CER이 높아 병동 전문 용어를 곧잘 놓칩니다.",
    where: "any",
    approxGb: 1.5,
  },
];

/** 콜랩의 기본 모델. 앱이 아무것도 안 고르면 노트의 드롭다운(같은 값)이 정한다. */
export const DEFAULT_COLAB_MODEL_ID = "nsr-korean-medium";

export function getServerModel(id: string): ServerAsrModel | undefined {
  return SERVER_MODELS.find((m) => m.id === id);
}

/** 이 모드에서 고를 수 있는 모델 목록. */
export function serverModelsFor(mode: "colab" | "pc"): ServerAsrModel[] {
  return mode === "colab" ? SERVER_MODELS : SERVER_MODELS.filter((m) => m.where === "any");
}
