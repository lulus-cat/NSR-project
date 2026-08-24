import type { LexiconEntry } from "./types.js";

/**
 * 검체 · 용기 · 기구를 부르는 말, 그리고 병동에서만 통하는 표현들.
 *
 * 여기 있는 말들의 공통점은 **사전에 없다는 것**이다.
 * "바틀 두 개 나가요", "퍼플 튜브에 담아", "이 환자 내려요" — 셋 다 국어사전에도
 * 의학사전에도 없다. 그런데 인계에서는 매일 나온다. 신규가 못 알아듣고 못 묻는 게
 * 정확히 이런 말들이다.
 *
 * 채혈 튜브를 색으로 부르는 관행에 대해
 * ----------------------------------
 * 현장에서는 "퍼플", "블루", "골드"처럼 뚜껑 색으로 부른다. 그런데 **색과 첨가제의
 * 대응은 제조사와 기관에 따라 다를 수 있다.** 그래서 여기서는 널리 쓰이는 대응을
 * 적되, 실제 판단은 검사실 지침을 따르라고 못 박아 둔다. 색만 믿고 담으면 사고가 난다.
 */
export const SPECIMEN_TERMS: LexiconEntry[] = [
  // ── 혈액배양 ────────────────────────────────────────────
  {
    id: "culture-bottle",
    ko: "혈액배양병",
    en: "blood culture bottle",
    aliases: ["바틀", "보틀", "배양병", "컬쳐바틀", "컬처보틀", "블러드컬쳐바틀"],
    category: "lab",
    definition:
      "혈액배양 검사용 배양액이 든 병. 호기성(aerobic)과 혐기성(anaerobic) 두 개가 한 세트다.",
    informal: true,
    formal: "혈액배양병",
    pitfall:
      "주사기로 채혈했으면 혐기성 병에 먼저 넣는다. 주사기 안의 공기가 혐기성 배양을 망치기 때문이다. 나비바늘로 직접 연결할 때는 반대로 호기성이 먼저다.",
    sources: ["kdca-hai"],
  },
  {
    id: "aerobic-bottle",
    ko: "호기성 배양병",
    en: "aerobic bottle",
    aliases: ["에어로빅", "호기성", "호기성바틀", "에어로빅바틀"],
    category: "lab",
    definition: "산소가 있어야 자라는 균을 배양하는 병.",
    informal: true,
    formal: "호기성 배양병",
  },
  {
    id: "anaerobic-bottle",
    ko: "혐기성 배양병",
    en: "anaerobic bottle",
    aliases: ["아나에로빅", "혐기성", "혐기성바틀", "애너로빅"],
    category: "lab",
    definition: "산소가 없어야 자라는 균을 배양하는 병.",
    informal: true,
    formal: "혐기성 배양병",
  },
  {
    id: "blood-culture-set",
    ko: "혈액배양 세트",
    en: "blood culture set",
    aliases: ["컬쳐세트", "배양세트", "세트로 나가다", "투세트"],
    category: "lab",
    definition: "호기성·혐기성 병 한 쌍. 오염 여부를 가리려면 서로 다른 부위에서 2세트가 원칙이다.",
    informal: true,
    formal: "혈액배양 세트",
    pitfall:
      "한 자리에서 한 세트만 뽑으면 균이 자라도 오염인지 진짜인지 구분이 안 된다. 항생제 투여 전에 뽑아야 하는 것도 잊기 쉽다.",
    sources: ["kdca-hai"],
  },

  // ── 채혈 튜브 ───────────────────────────────────────────
  {
    id: "blood-tube",
    ko: "채혈 튜브",
    en: "blood collection tube",
    aliases: ["튜브", "채혈튜브", "검체튜브", "랩튜브"],
    category: "lab",
    definition: "혈액을 담는 용기. 뚜껑 색으로 첨가제와 용도를 구분한다.",
    informal: true,
    formal: "채혈 용기",
    pitfall:
      "색과 첨가제의 대응은 제조사·기관에 따라 다를 수 있다. 색만 보고 담지 말고 검사실 지침을 확인한다.",
  },
  {
    id: "order-of-draw",
    ko: "채혈 순서",
    en: "order of draw",
    aliases: ["채혈순서", "오더오브드로우", "튜브순서", "뽑는순서"],
    category: "lab",
    definition:
      "여러 튜브에 채혈할 때 지켜야 하는 순서. 첨가제가 다음 튜브로 넘어가 결과를 틀어지게 만드는 것을 막는다.",
    pitfall:
      "혈액배양이 가장 먼저다. 그 뒤로는 응고(시트르산) → 혈청 → 헤파린 → EDTA → 불화나트륨 순이 널리 쓰인다. 순서가 바뀌면 특히 응고검사와 칼륨 결과가 틀어진다.",
  },
  {
    id: "edta-tube",
    ko: "EDTA 튜브",
    en: "EDTA tube",
    abbr: "EDTA",
    aliases: ["퍼플", "퍼플튜브", "보라색튜브", "이디티에이"],
    category: "lab",
    definition: "칼슘을 묶어 응고를 막는 항응고제가 든 튜브. CBC 등 혈구 검사에 쓴다. 통상 보라색 뚜껑.",
    informal: true,
    formal: "EDTA 항응고 용기",
    pitfall: "충분히 섞지 않으면 응고되어 재채혈해야 한다. 뒤집어 섞되 흔들면 용혈된다.",
  },
  {
    id: "sst-tube",
    ko: "혈청분리 튜브",
    en: "serum separator tube",
    abbr: "SST",
    aliases: ["에스에스티", "골드", "골드튜브", "노란튜브", "혈청튜브"],
    category: "lab",
    definition: "응고시킨 뒤 혈청을 분리하는 젤이 든 튜브. 생화학·면역 검사에 쓴다. 통상 금색/노란색 뚜껑.",
    informal: true,
    formal: "혈청분리 용기",
  },
  {
    id: "heparin-tube",
    ko: "헤파린 튜브",
    en: "heparin tube",
    aliases: ["그린", "그린튜브", "초록튜브", "헤파린튜브"],
    category: "lab",
    definition: "헤파린으로 응고를 막는 튜브. 전해질 등 혈장 검사에 쓴다. 통상 초록색 뚜껑.",
    informal: true,
    formal: "헤파린 항응고 용기",
  },
  {
    id: "citrate-tube",
    ko: "구연산 튜브",
    en: "sodium citrate tube",
    aliases: ["블루", "블루튜브", "하늘색튜브", "시트르산튜브", "응고튜브"],
    category: "lab",
    definition: "PT·aPTT 같은 응고검사용 튜브. 통상 하늘색 뚜껑.",
    informal: true,
    formal: "구연산나트륨 용기",
    pitfall:
      "표시선까지 정확히 채워야 한다. 혈액과 첨가제의 비율이 결과를 정하기 때문에, 덜 차면 응고시간이 실제보다 길게 나온다.",
  },
  {
    id: "fluoride-tube",
    ko: "불화나트륨 튜브",
    en: "sodium fluoride tube",
    aliases: ["그레이", "회색튜브", "그레이튜브", "당검사튜브"],
    category: "lab",
    definition: "당분해를 막아 혈당을 안정시키는 튜브. 통상 회색 뚜껑.",
    informal: true,
    formal: "불화나트륨 용기",
  },
  {
    id: "hemolysis",
    ko: "용혈",
    en: "hemolysis",
    aliases: ["헤몰리시스", "용혈", "터졌다", "깨졌다"],
    category: "lab",
    definition: "적혈구가 파괴되어 검체가 붉게 변한 것. 칼륨 등이 실제보다 높게 나온다.",
    informal: true,
    formal: "용혈",
    pitfall:
      "가는 바늘로 세게 뽑거나 튜브를 흔들면 생긴다. 용혈된 검체의 칼륨 수치를 믿고 처치하면 위험하다. 재채혈이 답이다.",
  },
  {
    id: "specimen-label",
    ko: "검체 라벨",
    en: "specimen labeling",
    aliases: ["라벨링", "바코드", "스티커", "검체라벨"],
    category: "lab",
    definition: "검체 용기에 대상자와 검사 정보를 붙이는 것.",
    pitfall:
      "라벨은 **환자 앞에서, 채혈 직후에** 붙인다. 미리 붙여 두거나 스테이션에서 붙이면 바뀐다. 검체 바뀜은 되돌릴 수 없는 사고다.",
    sources: ["koiha"],
  },

  // ── 용기 · 기구 ─────────────────────────────────────────
  {
    id: "urine-bag",
    ko: "소변주머니",
    en: "urine bag",
    aliases: ["유린백", "우린백", "소변백", "유린빽"],
    category: "device",
    definition: "유치도뇨관에 연결해 소변을 모으는 주머니.",
    informal: true,
    formal: "소변주머니",
    pitfall: "방광보다 높이 들면 역류해서 요로감염이 된다. 이동시킬 때 무심코 침대 위에 올리는 것이 가장 흔한 실수다.",
    sources: ["khna-guideline", "kdca-hai"],
  },
  {
    id: "iv-bag",
    ko: "수액백",
    en: "IV bag",
    aliases: ["수액백", "아이브이백", "수액팩", "링거백"],
    category: "device",
    definition: "수액이 담긴 주머니.",
    informal: true,
    formal: "수액 용기",
  },
  {
    id: "iv-set",
    ko: "수액세트",
    en: "IV administration set",
    aliases: ["아이브이셋", "수액셋", "라인셋", "수액줄"],
    category: "device",
    definition: "수액백과 환자를 잇는 관과 조절기 일습.",
    informal: true,
    formal: "수액 주입세트",
    pitfall: "교환 주기가 정해져 있다. 지질·혈액 제제는 훨씬 짧다. 언제 갈았는지 적어 두지 않으면 아무도 모른다.",
    sources: ["khna-guideline"],
  },
  {
    id: "dressing-set",
    ko: "드레싱 세트",
    en: "dressing set",
    aliases: ["드레싱셋", "드셋", "소독세트", "멸균세트"],
    category: "device",
    definition: "상처 소독에 쓰는 멸균 기구 일습.",
    informal: true,
    formal: "멸균 드레싱 세트",
    pitfall: "멸균 유효기간과 표시기(인디케이터)를 열기 전에 본다. 열고 나서 확인하면 이미 늦었다.",
  },
  {
    id: "treatment-tray",
    ko: "처치 트레이",
    en: "treatment tray",
    aliases: ["트레이", "쟁반", "처치트레이"],
    category: "device",
    definition: "처치 물품을 담아 옮기는 판.",
    informal: true,
    formal: "처치 트레이",
  },
  {
    id: "elastic-bandage",
    ko: "탄력붕대",
    en: "elastic bandage",
    abbr: "EB",
    aliases: ["이비", "이비감기", "탄력붕대", "압박붕대"],
    category: "device",
    definition: "늘어나는 붕대. 압박과 고정에 쓴다.",
    informal: true,
    formal: "탄력붕대",
    pitfall: "너무 조이면 순환이 막힌다. 감은 뒤 말단의 색·온도·감각을 확인하고 기록한다.",
  },
  {
    id: "normal-saline-slang",
    ko: "생리식염수",
    en: "normal saline",
    aliases: ["노멀", "노멀세이린", "노말", "엔에스", "생식"],
    category: "medication",
    definition: "체액과 삼투압이 비슷한 0.9% 염화나트륨 용액.",
    informal: true,
    formal: "생리식염수",
  },
  {
    id: "half-saline",
    ko: "0.45% 식염수",
    en: "half saline",
    aliases: ["하프", "하프세이린", "하프사린", "반생식"],
    category: "medication",
    definition: "생리식염수의 절반 농도인 저장성 용액.",
    informal: true,
    formal: "0.45% 염화나트륨 용액",
  },

  // ── 상황을 부르는 말 ────────────────────────────────────
  {
    id: "swamped",
    ko: "일이 몰려 감당이 안 되는 상태",
    en: "swamped",
    aliases: ["떡치다", "떡친다", "떡쳤다", "말렸다", "터졌다"],
    category: "shift",
    definition: "일이 한꺼번에 몰려 손이 모자란 상태를 이르는 말.",
    informal: true,
    formal: "업무 과부하",
    pitfall:
      "혼자 버티려다 놓치는 것이 사고가 된다. 도움을 요청하는 것이 늦어지는 것보다 낫다. 반복되면 인력 배치 문제이지 개인의 역량 문제가 아니다.",
  },
  {
    id: "orderly-pejorative",
    ko: "지시만 수행하는 간호사를 낮춰 부르는 말",
    en: "orderly (pejorative)",
    aliases: ["오더리"],
    category: "role",
    definition:
      "처방 수행만 하고 스스로 판단하지 않는다는 뜻으로 동료를 낮춰 부르는 말. 비하 표현이다.",
    informal: true,
    formal: "(비하 표현 — 기록에 쓰지 않는다)",
    pitfall:
      "동료를 향해 쓰이면 인격 모독에 해당할 수 있다. 반복적으로 들었다면 근무 환경 기록에 남겨 둘 만한 말이다.",
    sources: ["knahr", "moel"],
  },
  {
    id: "transfer-up-down",
    ko: "병실을 옮기다 (완곡어)",
    en: "move up / move down",
    aliases: ["올린다", "내린다", "올려요", "내려요", "올라간다", "내려간다"],
    category: "workflow",
    definition:
      "환자를 다른 곳으로 옮기는 것을 에둘러 이르는 말. '올린다'는 대개 상태가 좋아져 일반병동으로, '내린다'는 상태가 나빠졌거나 사망 후 옮기는 것을 뜻한다.",
    informal: true,
    formal: "전동 / 이송",
    pitfall:
      "환자와 보호자가 듣는 자리에서 쓰지 않는다. 완곡어라 신규는 뜻을 모른 채 넘어가기 쉬운데, 기록에는 어디로 왜 옮겼는지를 그대로 적어야 한다.",
  },
  {
    id: "hold-the-fort",
    ko: "자리를 맡아 주다",
    en: "cover",
    aliases: ["커버해주다", "봐주다", "대신 봐줘", "맡아줘"],
    category: "workflow",
    definition: "잠시 자리를 비우는 동안 다른 간호사가 담당 환자를 대신 보는 것.",
    informal: true,
    formal: "일시 인계",
    pitfall:
      "짧은 시간이라도 무엇을 봐야 하는지 넘겨야 한다. '잠깐만요'로 넘긴 사이에 생긴 일은 책임 소재가 흐려진다.",
  },
];
