/**
 * 온디바이스 모델 목록과 선택 판단.
 *
 * 왜 여러 개를 두는가
 * -----------------
 * 한 모델로는 안 된다. 기기 성능과 상황이 너무 다르다.
 *
 *   구형 폰 + 8시간 녹음  → 작은 모델 아니면 밤새 돌려도 안 끝난다
 *   최신 폰 + 중요한 근무 → 큰 모델로 정확도를 사는 게 맞다
 *   충전 중 · 오프 날     → 큰 모델을 돌릴 유일한 시간
 *
 * 그래서 모델을 **골라서 받고, 상황에 따라 바꿔 쓰는** 구조로 둔다.
 *
 * 크기보다 한국어가 먼저다
 * ----------------------
 * 공개된 실측에서 whisper-small 원본의 한국어 CER 이 18.05%인데,
 * 같은 크기를 한국어로 재학습하면 6.45%로 떨어진다. 세 배 차이다.
 * 반면 small → large-v3 는 18% → 8~12% 수준이다.
 *
 * 즉 **모델을 키우는 것보다 한국어로 학습된 것을 쓰는 쪽이 훨씬 크게 먹힌다.**
 * 목록에서 한국어 파인튜닝 모델을 위에 두는 이유다.
 *
 * 속도를 미리 못 적는 이유
 * ----------------------
 * 폰마다 몇 배씩 차이가 난다. 그래서 절대 속도를 적지 않고
 * **small 대비 상대 속도**만 둔다. 앱이 기기에서 small 을 한 번 재보고
 * 나머지를 추정한다 (`estimateMinutes`). 남의 폰 벤치마크를 적어 두는 것보다 정직하다.
 */

export type ModelFamily =
  /** OpenAI 원본을 ggml 로 변환한 것. 한국어 학습이 따로 안 됨. */
  | "whisper-official"
  /** 한국어로 재학습된 것. 같은 크기면 이쪽이 훨씬 낫다. */
  | "whisper-korean"
  /** 사용자가 직접 넣은 것. */
  | "custom";

export interface KoreanAccuracy {
  /** 문자 오류율(%). 낮을수록 좋다. */
  cer: number;
  /** 어디서 나온 숫자인지. 출처 없는 숫자는 적지 않는다. */
  source: string;
}

export interface AsrModel {
  id: string;
  name: string;
  /** ggml 파일 이름. whisper.cpp 가 이 이름으로 찾는다. */
  file: string;
  /** 받을 곳. 사용자가 직접 넣는 모델은 비어 있을 수 있다. */
  url?: string;
  /** 대략적인 파일 크기(MB). 실제 크기는 받아 봐야 안다. */
  approxSizeMb: number;
  family: ModelFamily;
  /**
   * 한국어 정확도. **모르면 null 이다.**
   * 추정치를 적어 두면 사용자가 그걸 사실로 받아들인다.
   */
  korean: KoreanAccuracy | null;
  /** small 을 1.0 으로 둔 상대 속도. 클수록 빠르다. */
  relativeSpeed: number;
  /** 언제 이걸 고르면 되는지. */
  guidance: string;
}

const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/**
 * whisper.cpp 공식 배포 모델.
 *
 * 파일 이름과 배포처는 확인된 것이다. **크기는 대략치**이고,
 * 한국어 CER 은 공개 벤치마크 종합이라 폭이 넓다 — 테스트셋에 따라 달라진다.
 * 양자화(q5_1 등)는 파일을 절반 이하로 줄이고 정확도 손실은 작은 편이다.
 */
/**
 * 한국어 파인튜닝 모델은 우리 저장소 Releases(models 태그)에 미러해 두고
 * 거기서 받는다. HF 원본은 f16(1.5GB)뿐이라 릴리스 워크플로가 q5_0 으로
 * 양자화해 올린다. 링크가 우리 손에 있으니 죽지 않는다.
 */
const MIRROR = "https://github.com/lulus-cat/NSR-project/releases/download/models";

export const OFFICIAL_MODELS: AsrModel[] = [
  {
    id: "korean-medium-q5_0",
    name: "한국어 Medium (파인튜닝)",
    file: "ggml-korean-medium-q5_0.bin",
    url: `${MIRROR}/ggml-korean-medium-q5_0.bin`,
    approxSizeMb: 539,
    family: "whisper-korean",
    // 제작자가 밝힌 것은 학습량(한국어 200시간)뿐, 이 판의 CER 실측은 없다.
    korean: null,
    relativeSpeed: 0.4,
    guidance:
      "한국어 200시간으로 재학습된 Medium입니다. 같은 크기의 원본보다 한국어가 " +
      "크게 낫습니다. 대부분의 기기에서 이 모델을 권장합니다.",
  },
  {
    id: "korean-large-v3-turbo-q5_0",
    name: "한국어 Large v3 Turbo (파인튜닝)",
    file: "ggml-korean-large-v3-turbo-q5_0.bin",
    url: `${MIRROR}/ggml-korean-large-v3-turbo-q5_0.bin`,
    approxSizeMb: 574,
    family: "whisper-korean",
    korean: null,
    relativeSpeed: 0.7,
    guidance:
      "한국어로 재학습된 Turbo입니다. Medium보다 빠르고 정확도도 좋은 편이나 " +
      "낭독 음성으로 학습되어 대화체에서는 체감이 다를 수 있습니다.",
  },
  {
    id: "tiny-q5_1",
    name: "Tiny (양자화)",
    file: "ggml-tiny-q5_1.bin",
    url: `${HF}/ggml-tiny-q5_1.bin`,
    approxSizeMb: 31,
    family: "whisper-official",
    korean: null,
    relativeSpeed: 6,
    guidance:
      "속도가 빠르나 한국어 인식률이 낮습니다. 전사 동작 테스트 용도로 사용합니다.",
  },
  {
    id: "base-q5_1",
    name: "Base (양자화)",
    file: "ggml-base-q5_1.bin",
    url: `${HF}/ggml-base-q5_1.bin`,
    approxSizeMb: 57,
    family: "whisper-official",
    korean: null,
    relativeSpeed: 3.5,
    guidance: "구형 기기용 모델입니다. 전문 용어 인식률은 낮습니다.",
  },
  {
    id: "small-q5_1",
    name: "Small (양자화)",
    file: "ggml-small-q5_1.bin",
    url: `${HF}/ggml-small-q5_1.bin`,
    approxSizeMb: 181,
    family: "whisper-official",
    korean: { cer: 18.05, source: "ENERZAi 공개 실측" },
    relativeSpeed: 1,
    guidance:
      "원본 기본 모델입니다. 한국어 인식률이 낮아 보조용으로 적합합니다." +
      "동일 크기의 한국어 파인튜닝 모델 사용을 권장합니다.",
  },
  {
    id: "medium-q5_0",
    name: "Medium (양자화)",
    file: "ggml-medium-q5_0.bin",
    url: `${HF}/ggml-medium-q5_0.bin`,
    approxSizeMb: 514,
    family: "whisper-official",
    korean: null,
    relativeSpeed: 0.4,
    guidance: "정확도와 속도의 균형 모델입니다. 성능이 높은 기기에 적합합니다.",
  },
  {
    id: "large-v3-turbo-q5_0",
    name: "Large v3 Turbo (양자화)",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: `${HF}/ggml-large-v3-turbo-q5_0.bin`,
    approxSizeMb: 574,
    family: "whisper-official",
    korean: null,
    relativeSpeed: 0.7,
    guidance:
      "Large 계열의 속도 개선 모델입니다. 고성능 모델 사용 시" +
      "Large-v3 원본보다 실용적입니다.",
  },
  {
    id: "large-v3-q5_0",
    name: "Large v3 (양자화)",
    file: "ggml-large-v3-q5_0.bin",
    url: `${HF}/ggml-large-v3-q5_0.bin`,
    approxSizeMb: 1100,
    family: "whisper-official",
    korean: { cer: 10, source: "공개 벤치마크 종합 (8~12% 범위의 중간값)" },
    relativeSpeed: 0.25,
    guidance:
      "원본 모델 중 가장 정확하지만 기기 발열과 속도 저하가 발생할 수 있습니다." +
      "충전 중 장시간 전사 작업 시에만 사용을 권장합니다." +
      "한국어 전사는 파인튜닝된 Medium 모델의 성능이 더 우수합니다.",
  },
];

/**
 * 한국어 파인튜닝 모델을 어떻게 넣는가.
 *
 * 공개된 것이 여럿 있지만 **URL 을 여기 박아 두지 않는다.** 모델은 사라지고
 * 이름이 바뀌고 라이선스가 달라진다. 죽은 링크를 코드에 남기는 것보다
 * 넣는 방법을 알려주는 편이 오래간다.
 *
 * HuggingFace 의 파인튜닝 모델은 whisper.cpp 의 변환 스크립트로 ggml 이 된다.
 *
 *   python3 whisper.cpp/models/convert-h5-to-ggml.py \
 *     ./내려받은-모델-폴더/ ./whisper ./출력폴더
 *
 * 그 뒤 앱의 모델 화면에서 "직접 추가"로 파일이나 URL 을 넣는다.
 */
export const KOREAN_MODEL_GUIDE = {
  /**
   * 실제로 존재하는 한국어 파인튜닝 모델들.
   *
   * URL 을 박아 두지 않고 **id 만** 적는다. 주소는 바뀌고 파일명도 바뀌지만
   * id 로 검색하면 옮겨간 자리도 찾을 수 있다. 죽은 링크보다 낫다.
   *
   * 확인된 것 (2026-08 조사):
   *  - large-v3 는 **turbo 파생**에 생태계가 몰려 있다. 순수 large-v3 한국어
   *    파인튜닝은 하나뿐이고 성능 수치가 공개돼 있지 않다.
   *  - 아래 첫 항목은 **이미 ggml 로 변환돼 있어** 변환 없이 바로 넣을 수 있다.
   */
  known: [
    {
      id: "royshilkrot/whisper-large-v3-turbo-korean-ggml",
      base: "large-v3-turbo",
      note: "위 모델 목록의 '한국어 Large v3 Turbo'가 이 모델입니다 — 버튼으로 바로 받아집니다.",
      ready: true,
    },
    {
      id: "royshilkrot/whisper-medium-korean-ggml",
      base: "medium",
      note: "위 모델 목록의 '한국어 Medium'이 이 모델입니다 — 버튼으로 바로 받아집니다. 대화체 특화는 아래 장민(jangmin) 모델을 참고하십시오.",
      ready: true,
    },
    {
      id: "jangmin/whisper-medium-ko-normalized-1273h",
      base: "medium",
      note:
        "**대화체 특화 Medium 모델입니다.** AI Hub 음성 796시간 및" +
        "소음 대화 363시간 등 총 1,273시간 학습 — 실전 대화 데이터로" +
        "병동 대화 환경에 적합합니다. Safetensors 형식으로 ggml 변환 및 양자화가 필요합니다.",
      ready: false,
    },
    {
      id: "bybb138/whisper-large-v3-turbo-korean",
      base: "large-v3-turbo",
      note:
        "Zeroth Korean 206시간 학습. 모델 카드 실측 test CER 7.58% → 2.06%. " +
        "**다만 Zeroth는 낭독 음성 기반 데이터이므로" +
        "병동 대화 환경의 수치와는 차이가 있을 수 있습니다.**" +
        "Safetensors F32 형식으로 ggml 변환 및 양자화가 필요합니다." +
        "제작자 주: 학습 진행 중인 모델입니다.",
      ready: false,
    },
    {
      id: "ghost613/whisper-large-v3-turbo-korean",
      base: "large-v3-turbo",
      note: "동일 Zeroth 계열 모델입니다. ggml 변환이 필요합니다.",
      ready: false,
    },
    {
      id: "seastar105/whisper-medium-ko-zeroth",
      base: "medium",
      note: "Zeroth Korean 모델입니다. ggml 변환이 필요합니다.",
      ready: false,
    },
  ],
  searchHint: "HuggingFace에서 해당 ID로 검색하거나 'whisper korean ggml'을 검색하십시오.",
  convertCommand:
    "python3 whisper.cpp/models/convert-h5-to-ggml.py ./모델폴더/ ./whisper ./출력",
  /**
   * 변환만 하면 F32 그대로라 3GB 쯤 된다. 폰에 넣으려면 양자화까지 해야 한다.
   * q5_0 이면 1/5 로 줄고 정확도 손실은 작은 편이다.
   */
  quantizeCommand:
    "./build/bin/quantize ./출력/ggml-model.bin ./ggml-ko-turbo-q5_0.bin q5_0",
  why:
    "같은 크기에서 원본 CER 18.05% → 한국어 재학습 6.45%. " +
    "모델 크기 확대보다 정확도 개선 효과가 큽니다.",
  /**
   * 직접 파인튜닝을 생각한다면 알아야 할 것.
   *
   * large-v3 full fine-tune 은 24GB 로도 안 된다 — batch 1, 오디오 2.5초로
   * 잘라도 OOM 났다는 보고가 있다. LoRA + 8bit 면 **8GB** 로 떨어진다
   * (무료 Colab T4 실측). 8GB 노트북 GPU 는 경계선이고 실측 사례가 없다.
   *
   * 데이터는 8~12시간이면 의미 있는 개선의 최소선(HF 공식 블로그),
   * 위 한국어 turbo 모델은 200시간을 썼다.
   */
  finetune: {
    fullVramGb: 24,
    loraVramGb: 8,
    minHours: 8,
    note: "파인튜닝 전 사전 학습(known) 모델 테스트를 권장합니다.",
  },
} as const;

export function getModel(id: string): AsrModel | undefined {
  return OFFICIAL_MODELS.find((m) => m.id === id);
}

/** 앱이 처음 권하는 모델. 기기 성능을 모를 때의 안전한 출발점. */
export const DEFAULT_MODEL_ID = "small-q5_1";

// ────────────────────────────────────────────────────────────
//  시간 추정
// ────────────────────────────────────────────────────────────

export interface SpeedSample {
  /** 어떤 모델로 쟀는지. */
  modelId: string;
  /** 오디오 1초를 처리하는 데 걸린 실제 시간(초). 1보다 작으면 실시간보다 빠르다. */
  secondsPerAudioSecond: number;
}

export interface TranscribeEstimate {
  minutes: number;
  /** 실측 없이 추정한 값인가. 화면에서 "대략"이라고 표시해야 한다. */
  estimated: boolean;
  /** 사람이 읽을 한 줄. */
  label: string;
}

/**
 * 이 모델로 이 길이를 전사하면 얼마나 걸리는지.
 *
 * 기기에서 한 번 재 본 값(`sample`)이 있으면 그걸 기준으로 환산한다.
 * 없으면 못 한다고 말한다 — **남의 폰 숫자를 내 폰 숫자인 척 보여주지 않는다.**
 *
 * @param audioMinutes VAD 로 무음을 걷어낸 뒤의 실제 발화 길이
 */
export function estimateMinutes(
  model: AsrModel,
  audioMinutes: number,
  sample?: SpeedSample,
): TranscribeEstimate {
  if (!sample) {
    return {
      minutes: 0,
      estimated: true,
      label: "기기 측정을 통해 확인할 수 있습니다.",
    };
  }
  const base = getModel(sample.modelId);
  if (!base) {
    return { minutes: 0, estimated: true, label: "기준 모델을 찾지 못했습니다." };
  }

  // sample 은 base 모델 기준이다. 상대 속도로 목표 모델에 환산한다.
  const ratio = base.relativeSpeed / model.relativeSpeed;
  const minutes = audioMinutes * sample.secondsPerAudioSecond * ratio;
  const rounded = Math.round(minutes);

  return {
    minutes: rounded,
    estimated: model.id !== sample.modelId,
    label:
      rounded >= 60
        ? `약 ${Math.floor(rounded / 60)}시간 ${rounded % 60}분`
        : `약 ${rounded}분`,
  };
}

/**
 * 이 근무를 이 모델로 돌리는 게 현실적인가.
 *
 * 기준은 단순하다 — **다음 근무 전에 끝나야 한다.** 안 끝나면 쌓이고,
 * 쌓이면 앱을 안 열게 된다.
 */
export interface Feasibility {
  ok: boolean;
  reason?: string;
}

export function checkFeasible(
  estimate: TranscribeEstimate,
  hoursUntilNextShift: number,
): Feasibility {
  if (estimate.minutes === 0) {
    return { ok: true, reason: "측정 데이터가 없어 판단할 수 없습니다." };
  }
  const available = hoursUntilNextShift * 60;
  if (estimate.minutes > available) {
    return {
      ok: false,
      reason:
        `소요 예상 시간 ${estimate.label}, 다음 근무까지 ${Math.round(available)}분 남았습니다.` +
        "더 작은 모델을 선택하거나 오프 날 진행하십시오.",
    };
  }
  if (estimate.minutes > available * 0.6) {
    return {
      ok: true,
      reason: "전사 중에는 기기 충전을 유지하십시오.",
    };
  }
  return { ok: true };
}

/** 사용자가 직접 넣은 모델을 검증한다. */
export interface CustomModelInput {
  name: string;
  file: string;
  url?: string;
  approxSizeMb?: number;
}

export function makeCustomModel(input: CustomModelInput): {
  model: AsrModel | null;
  error?: string;
} {
  const name = input.name.trim();
  const file = input.file.trim();
  if (!name) return { model: null, error: "이름을 입력하십시오." };
  if (!file.endsWith(".bin")) {
    return { model: null, error: "whisper.cpp는 ggml .bin 파일만 지원합니다." };
  }
  if (input.url && !/^https:\/\//i.test(input.url)) {
    return { model: null, error: "URL은 https://로 시작해야 합니다." };
  }
  return {
    model: {
      id: `custom-${file.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`,
      name,
      file,
      url: input.url,
      approxSizeMb: input.approxSizeMb ?? 0,
      family: "custom",
      // 남이 만든 모델의 정확도를 우리가 알 수 없다. 모르면 모른다고 둔다.
      korean: null,
      // 크기로 속도를 짐작한다. 정확하지 않으니 재보라고 안내한다.
      relativeSpeed: input.approxSizeMb
        ? Math.max(0.15, 181 / Math.max(input.approxSizeMb, 1))
        : 1,
      guidance: "사용자 추가 모델입니다. 속도는 기기 측정을 통해 확인하십시오.",
    },
  };
}
