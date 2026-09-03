import type { LexiconEntry } from "./types.js";

/**
 * 수술실과 요양병원 용어.
 *
 * 왜 따로 두는가
 * ------------
 * 지금까지의 사전은 급성기 병동 기준이다. 그런데 수술실과 요양병원은
 * **쓰는 말이 절반쯤 다르다.**
 *
 *   병동에서 하루 종일 나오는 말이 수술실에서는 한 번도 안 나온다 (인계, 노티, 듀티)
 *   수술실에서 매 수술 나오는 말이 병동에는 없다 (카운트, 타임아웃, 보비, 드레이핑)
 *   요양병원은 또 다르다 (와상, 연하곤란, 장기요양등급, 촉탁의)
 *
 * 부서를 옮기면 신규가 다시 신규가 되는 이유가 이것이다.
 * 사전이 한 부서만 알고 있으면 옮긴 사람에게는 없는 것과 같다.
 */

/** 수술실 */
export const OR_TERMS: LexiconEntry[] = [
  {
    id: "or-timeout",
    ko: "타임아웃",
    en: "surgical time-out",
    aliases: ["타임아웃", "타임아웃하다", "수술전확인"],
    category: "procedure",
    definition:
      "절개 직전 모든 인원이 하던 일을 멈추고 환자·부위·술식을 소리 내어 확인하는 절차.",
    pitfall:
      "형식적으로 넘기면 안 하는 것과 같다. 부위 오류 수술을 막는 마지막 관문이고, 인증 조사 항목이기도 하다.",
    sources: ["koiha"],
  },
  {
    id: "or-count",
    ko: "카운트",
    en: "surgical count",
    aliases: ["카운트", "거즈카운트", "기구카운트", "카운트맞다"],
    category: "procedure",
    definition: "수술 전·중·후에 거즈·바늘·기구 수를 세어 맞추는 절차.",
    informal: true,
    formal: "수술계수",
    pitfall:
      "카운트가 안 맞으면 봉합을 못 한다. 방사선 촬영으로 확인할 때까지 수술이 끝나지 않는다. 체내 잔류는 되돌릴 수 없는 사고다.",
    sources: ["koiha"],
  },
  {
    id: "or-bovie",
    ko: "전기소작기",
    en: "electrosurgical unit (Bovie)",
    aliases: ["보비", "보비질", "전기소작", "카우터", "코터"],
    category: "device",
    definition: "고주파 전류로 조직을 자르거나 지혈하는 기구. 상표명이 그대로 이름이 됐다.",
    informal: true,
    formal: "전기수술기",
    pitfall:
      "접지판(패드)이 제대로 붙지 않으면 그 자리에 화상이 생긴다. 알코올 소독제가 마르기 전에 쓰면 불이 붙는다.",
  },
  {
    id: "or-prep",
    ko: "피부 소독",
    en: "skin preparation",
    aliases: ["프렙", "프렙하다", "스킨프렙", "피부소독"],
    category: "procedure",
    definition: "수술 부위 피부를 소독제로 닦아 균을 줄이는 것.",
    informal: true,
    formal: "수술부위 피부 소독",
    pitfall: "알코올 성분 소독제는 완전히 마른 뒤 드레이핑한다. 젖은 채로 덮고 소작하면 화재가 난다.",
    sources: ["kdca-hai"],
  },
  {
    id: "or-draping",
    ko: "드레이핑",
    en: "draping",
    aliases: ["드레이핑", "드레입", "소독포덮기", "포깔기"],
    category: "procedure",
    definition: "멸균포로 수술 부위만 남기고 덮어 멸균영역을 만드는 것.",
    informal: true,
    formal: "멸균포 적용",
    pitfall: "한 번 놓은 포는 당겨 올리지 않는다. 아래에서 위로 온 것은 오염으로 본다.",
  },
  {
    id: "or-positioning",
    ko: "체위 잡기",
    en: "surgical positioning",
    aliases: ["포지셔닝", "체위잡기", "포지션"],
    category: "procedure",
    definition: "술식에 맞게 환자 자세를 잡고 고정하는 것.",
    informal: true,
    formal: "수술 체위 적용",
    pitfall:
      "마취된 환자는 아프다고 말하지 못한다. 신경 압박과 압력손상이 여기서 생기고, 몇 시간 뒤에야 드러난다. 골돌출부 패딩을 반드시 확인한다.",
  },
  {
    id: "or-induction",
    ko: "마취 유도",
    en: "induction of anesthesia",
    aliases: ["인덕션", "마취유도", "인덕션들어간다"],
    category: "procedure",
    definition: "마취제를 투여해 의식을 잃게 하는 단계.",
    informal: true,
    formal: "마취 유도",
    pitfall: "가장 불안정한 구간 중 하나다. 이 시간에는 자리를 뜨지 않고 활력징후를 본다.",
  },
  {
    id: "or-emergence",
    ko: "마취 각성",
    en: "emergence from anesthesia",
    aliases: ["이머전스", "각성", "깨는중"],
    category: "procedure",
    definition: "마취에서 깨어나는 단계.",
    informal: true,
    formal: "마취 각성",
    pitfall: "기도 폐쇄와 후두경련이 잘 생기는 구간이다. 발관 직후 몇 분이 특히 위험하다.",
  },
  {
    id: "or-spinal",
    ko: "척추마취",
    en: "spinal anesthesia",
    aliases: ["스파이널", "척추마취", "하반신마취"],
    category: "procedure",
    definition: "지주막하 공간에 마취제를 주입해 하반신을 마취하는 방법.",
    pitfall: "마취 높이가 올라가면 혈압이 급격히 떨어지고 호흡이 어려워진다. 혈압을 자주 잰다.",
  },
  {
    id: "or-epidural",
    ko: "경막외마취",
    en: "epidural anesthesia",
    aliases: ["에피듀랄", "에피", "경막외"],
    category: "procedure",
    definition: "경막외 공간에 마취제를 주입하는 방법. 수술 후 통증조절에도 쓴다.",
  },
  {
    id: "or-frozen",
    ko: "동결절편검사",
    en: "frozen section",
    aliases: ["프로즌", "프리즌", "동결절편", "프로즌보낸다"],
    category: "lab",
    definition: "수술 중에 조직을 얼려 급히 검사해 절제 범위를 정하는 것.",
    informal: true,
    formal: "동결절편검사",
    pitfall: "결과를 기다리는 동안 수술이 멈춘다. 검체 표시가 틀리면 절제 범위가 잘못 정해진다.",
  },
  {
    id: "or-specimen",
    ko: "수술 검체",
    en: "surgical specimen",
    aliases: ["스페시멘", "검체", "조직"],
    category: "lab",
    definition: "수술 중 떼어낸 조직.",
    pitfall:
      "부위·좌우·개수를 집도의에게 소리 내어 확인하고 라벨에 적는다. 검체가 바뀌면 진단과 이후 치료가 통째로 틀어진다.",
    sources: ["koiha"],
  },
  {
    id: "or-retractor",
    ko: "견인기",
    en: "retractor",
    aliases: ["리트랙터", "견인기", "리트렉터"],
    category: "device",
    definition: "수술 시야를 확보하려고 조직을 벌려 잡아주는 기구.",
  },
  {
    id: "or-suture",
    ko: "봉합사",
    en: "suture",
    aliases: ["봉합사", "실크", "바이크릴", "나일론", "프롤렌", "피디에스"],
    category: "device",
    definition:
      "조직을 꿰매는 실. 녹는 것(바이크릴·PDS)과 안 녹는 것(실크·나일론·프롤렌)으로 나뉜다.",
    pitfall: "굵기(0, 2-0, 3-0…)는 숫자가 클수록 가늘다. 요청받은 것과 다른 굵기를 주면 다시 열어야 할 수 있다.",
  },
  {
    id: "or-autoclave",
    ko: "고압증기멸균",
    en: "autoclave",
    aliases: ["오토클레이브", "고압증기", "멸균기"],
    category: "device",
    definition: "고온·고압 증기로 기구를 멸균하는 장비.",
    pitfall: "화학·생물학적 표시기 결과를 확인하기 전에는 멸균된 것으로 보지 않는다.",
    sources: ["kdca-hai"],
  },
  {
    id: "or-indicator",
    ko: "멸균 표시기",
    en: "sterilization indicator",
    aliases: ["인디케이터", "표시기", "멸균테이프"],
    category: "device",
    definition: "멸균 조건이 충족됐는지 색 변화 등으로 알려주는 표시.",
    pitfall: "포장을 열기 **전에** 본다. 열고 나서 확인하면 이미 멸균영역이 만들어진 뒤다.",
  },
  {
    id: "or-closing",
    ko: "봉합 시작",
    en: "closing",
    aliases: ["클로징", "클로즈", "닫는다", "봉합들어간다"],
    category: "procedure",
    definition: "수술을 마치고 층별로 꿰매기 시작하는 단계.",
    informal: true,
    formal: "봉합",
    pitfall: "클로징 전에 최종 카운트가 맞아야 한다. 이 순서가 뒤집히면 안 된다.",
  },
];

/** 요양병원 · 장기요양 */
export const LTC_TERMS: LexiconEntry[] = [
  {
    id: "ltc-bedridden",
    ko: "와상",
    en: "bedridden",
    aliases: ["와상", "와상환자", "누워계신분", "베드리든"],
    category: "condition",
    definition: "스스로 일어나 앉거나 이동하지 못해 침상에서 지내는 상태.",
    pitfall:
      "욕창·관절구축·흡인성 폐렴·근감소가 한꺼번에 온다. 체위변경과 구강간호가 치료만큼 중요하다.",
    sources: ["khna-guideline"],
  },
  {
    id: "ltc-dysphagia",
    ko: "연하곤란",
    en: "dysphagia",
    aliases: ["연하곤란", "디스파지아", "삼킴장애", "사레잘듦"],
    category: "condition",
    definition: "음식이나 물을 삼키기 어려운 상태.",
    pitfall:
      "흡인성 폐렴의 가장 큰 원인이다. 식사 시 상체를 세우고, 사레가 잦으면 식이 형태(점도)를 다시 보게 한다.",
    sources: ["khna-guideline"],
  },
  {
    id: "ltc-contracture",
    ko: "관절구축",
    en: "joint contracture",
    aliases: ["구축", "관절구축", "굳었다", "컨트랙쳐"],
    category: "condition",
    definition: "오래 움직이지 않아 관절이 굳어 펴지지 않는 상태.",
    pitfall: "한 번 굳으면 되돌리기 어렵다. 예방이 전부다 — 수동 관절운동을 매일 기록으로 남긴다.",
  },
  {
    id: "ltc-bpsd",
    ko: "치매행동심리증상",
    en: "behavioral and psychological symptoms of dementia",
    abbr: "BPSD",
    // "배회"는 ltc-wandering이 따로 갖는다. 여기 두면 그쪽이 영영 안 잡힌다.
    aliases: ["비피에스디", "행동증상", "야간섬망"],
    category: "condition",
    definition: "치매에서 나타나는 배회·공격성·망상·수면장애 등의 증상.",
    pitfall:
      "약부터 늘리기 전에 원인을 찾는다 — 통증, 변비, 요폐, 소음, 낯선 사람. 억제대는 최후의 수단이다.",
  },
  {
    id: "ltc-wandering",
    ko: "배회",
    en: "wandering",
    aliases: ["배회", "돌아다니심", "나가려하심"],
    category: "condition",
    definition: "목적 없이 돌아다니거나 시설을 나가려 하는 행동.",
    pitfall: "막는 것보다 안전하게 걸을 수 있는 동선을 만드는 쪽이 낫다. 실종 대비 인적사항 확인을 미리 해둔다.",
  },
  {
    id: "ltc-incontinence",
    ko: "요실금·변실금",
    en: "incontinence",
    aliases: ["실금", "요실금", "변실금", "기저귀케어"],
    category: "condition",
    definition: "소변이나 대변을 참지 못해 새는 것.",
    pitfall:
      "젖은 채로 두면 피부가 짓무르고 욕창으로 간다. 기저귀 확인 주기를 정하고 기록한다. 유치도뇨로 대신하는 것은 감염 위험 때문에 신중해야 한다.",
    sources: ["khna-guideline"],
  },
  {
    id: "ltc-polypharmacy",
    ko: "다약제 복용",
    en: "polypharmacy",
    aliases: ["폴리파마시", "다약제", "약많이드심"],
    category: "medication",
    definition: "여러 약을 동시에 오래 복용하는 상태. 노인에서 흔하다.",
    pitfall:
      "약이 늘수록 상호작용과 낙상 위험이 커진다. 새 증상이 생기면 '병이 는 것'보다 '약 때문'을 먼저 의심하는 편이 맞을 때가 많다.",
    sources: ["mfds-drug"],
  },
  {
    id: "ltc-grade",
    ko: "장기요양등급",
    en: "long-term care grade",
    aliases: ["요양등급", "장기요양등급", "등급판정", "몇등급"],
    category: "documentation",
    definition:
      "노인장기요양보험에서 심신 상태에 따라 매기는 등급(1~5등급, 인지지원등급). 이용 가능한 급여와 본인부담이 달라진다.",
    pitfall: "등급은 상태가 변하면 갱신 신청을 해야 한다. 보호자가 모르는 경우가 많아 안내가 필요하다.",
    sources: ["law-go-kr"],
  },
  {
    id: "ltc-caregiver",
    ko: "요양보호사",
    en: "certified care worker",
    // "선생님"은 넣지 않는다. 병원에서 그 말은 의사·간호사·요양보호사 누구에게나 쓰이고,
    // 사전에 올리면 아무 "선생님"이나 요양보호사로 붙어버린다.
    aliases: ["요양보호사", "요보사"],
    category: "role",
    definition: "장기요양기관에서 신체활동과 일상생활을 지원하는 자격 인력.",
    pitfall:
      "위임할 수 있는 업무 범위가 법으로 정해져 있다. 투약과 의료행위는 넘길 수 없고, 넘기면 간호사가 책임진다.",
    sources: ["law-go-kr"],
  },
  {
    id: "ltc-visiting-doctor",
    ko: "촉탁의",
    en: "contracted physician",
    aliases: ["촉탁의", "촉탁의사", "방문의사"],
    category: "role",
    definition: "요양시설에 정기적으로 방문해 입소자를 진료하는 계약 의사.",
    pitfall:
      "상주가 아니라 방문이다. 방문일 사이에 생긴 변화는 간호사가 판단해 연락해야 하고, 그 판단 기준을 미리 정해두는 게 안전하다.",
  },
  {
    id: "ltc-advance-directive",
    ko: "사전연명의료의향서",
    en: "advance directive",
    aliases: ["사전의향서", "연명의료의향서", "사전연명"],
    category: "documentation",
    definition:
      "연명의료를 원하지 않는다는 뜻을 미리 문서로 남겨 둔 것. 연명의료결정법에 따른 제도다.",
    pitfall:
      "작성 여부는 국가 등록 시스템에서 확인한다. 가족의 말만으로 판단하지 않는다. 문서가 있어도 통증조절 등 다른 간호는 그대로 유지된다.",
    sources: ["law-go-kr"],
  },
  {
    id: "ltc-hospice",
    ko: "호스피스·완화의료",
    en: "hospice and palliative care",
    aliases: ["호스피스", "완화의료", "완화케어"],
    category: "workflow",
    definition: "치료보다 증상 완화와 삶의 질에 중점을 두는 돌봄.",
    pitfall: "'더 할 게 없다'가 아니다. 통증·호흡곤란·불안 조절은 오히려 더 적극적으로 한다.",
  },
  {
    id: "ltc-end-of-life",
    ko: "임종 돌봄",
    en: "end-of-life care",
    // "임종"만 따로 부르면 사망(expire)을 가리키는 말이다. 그쪽에 이미 있다.
    aliases: ["임종케어", "임종돌봄", "임박", "임종징후"],
    category: "workflow",
    definition: "사망이 임박한 시기의 돌봄과 가족 지원.",
    pitfall:
      "호흡 양상 변화·말초 청색증·의식 저하 같은 징후를 가족에게 미리 설명해 두면 그 순간의 충격이 줄어든다. 연락 우선순위를 기록에 남긴다.",
  },
  {
    id: "ltc-family-visit",
    ko: "면회",
    en: "family visit",
    aliases: ["면회", "면회오심", "보호자면회"],
    category: "workflow",
    definition: "가족·지인이 입소자를 만나러 오는 것.",
    pitfall:
      "면회는 상태를 설명할 기회이자 민원이 생기는 자리다. 무엇을 설명했는지 기록해 두면 나중에 말이 달라지는 일을 줄인다.",
  },
  {
    id: "ltc-fall-mat",
    ko: "낙상 예방 매트",
    en: "fall prevention mat",
    aliases: ["낙상매트", "매트깔기", "폴매트"],
    category: "device",
    definition: "침대에서 떨어졌을 때 충격을 줄이려고 바닥에 까는 매트.",
    pitfall:
      "매트를 깔았다고 낙상을 막은 것이 아니다. 침상 높이를 낮추고 호출벨을 손 닿는 곳에 두는 것이 먼저다.",
    sources: ["koiha"],
  },
{
    id: "warmer",
    ko: "워머",
    en: "warmer",
    aliases: ["가온기", "온열기", "베어허거"],
    category: "device",
    definition: "체온이 떨어진 환자를 덥히는 기구. 이불 밑으로 더운 바람을 넣는 형태가 흔하다.",
    pitfall: "덥히는 동안에도 체온을 다시 재야 한다. 켜 두고 잊으면 과열로 화상이 난다.",
  },
  {
    id: "diet",
    ko: "식이",
    en: "diet",
    aliases: ["식이표", "식단", "밥"],
    category: "documentation",
    definition: "환자에게 나가는 음식의 종류와 형태. 오더로 정해지고 바뀌면 전날 근무가 받는다.",
    pitfall:
      "식이가 바뀌는 오더는 바뀌는 날 전날 근무가 받는다. 당일 근무가 받으면 하루 어긋난다.",
  },
];

export const OR_LTC_TERMS: LexiconEntry[] = [...OR_TERMS, ...LTC_TERMS];
