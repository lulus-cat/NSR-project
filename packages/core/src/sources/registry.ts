/**
 * 공식 자료 출처 레지스트리.
 *
 * 왜 이걸 코드에 박아두는가
 * ------------------------
 * 신규간호사가 모르는 걸 찾을 때 가장 먼저 하는 건 검색이다. 그리고 검색 결과 상단에는
 * 블로그, 카페 글, 국시 요약본이 온다. 그중 상당수가 오래됐거나 병원마다 다른 걸
 * 일반론처럼 적어놨다. 잘못된 근거로 배운 술기는 나중에 고치기가 훨씬 어렵다.
 *
 * 그래서 이 앱은 **출처를 먼저 정해놓고** 거기서만 답을 찾도록 유도한다.
 * 용어 하나를 탭하면 그 용어와 연결된 공식 지침으로 바로 넘어간다.
 *
 * 저작권에 대해
 * ------------
 * 지침 본문(PDF)은 각 기관에 저작권이 있다. 앱은 **링크와 서지정보만** 보관하고
 * 본문을 복제·재배포하지 않는다. 사용자가 각 기관 사이트에서 직접 내려받아 보는 구조다.
 *
 * URL은 기관 사정으로 바뀔 수 있다. 링크가 깨지면 `publisher`와 `name`으로
 * 검색하도록 UI가 안내한다.
 */

export type SourceKind =
  | "guideline" // 임상 실무 지침
  | "law" // 법령
  | "drug" // 의약품 정보
  | "terminology" // 용어·분류 표준
  | "safety" // 환자안전
  | "education" // 교육 / 국가시험
  | "research" // 학술 검색
  | "rights"; // 노동·인권

export type SourceAccess = "free" | "member" | "paid";

export interface OfficialSource {
  id: string;
  name: string;
  publisher: string;
  url: string;
  kind: SourceKind;
  access: SourceAccess;
  description: string;
  /** 주제 태그. 용어에서 출처를 역으로 찾을 때 쓴다. */
  topics: string[];
  /** 사용 시 주의사항. */
  caution?: string;
}

export const OFFICIAL_SOURCES: OfficialSource[] = [
  {
    id: "khna-guideline",
    name: "근거기반 임상간호실무지침",
    publisher: "병원간호사회",
    url: "https://khna.or.kr/home/pds/utilities.php",
    kind: "guideline",
    access: "free",
    description:
      "국내 간호 실무의 사실상 표준 지침. 정맥주입요법, 욕창, 낙상, 통증, 억제대, 경장영양, 유치도뇨, 흡인, 구강간호, 수혈 등 주제별로 나뉘어 있고 매년 개정된다. 권고마다 근거수준과 권고등급이 붙어 있어 '왜 그렇게 하는지'까지 확인할 수 있다.",
    topics: [
      "정맥주입", "욕창", "낙상", "통증", "억제대", "경장영양", "유치도뇨",
      "흡인", "구강간호", "수혈", "감염관리", "체위변경", "상처",
    ],
    caution:
      "지침은 일반 원칙이다. 실제 수행은 소속 병원 프로토콜이 우선하며, 둘이 다르면 프리셉터·감염관리실에 확인해야 한다.",
  },
  {
    id: "kdca-hai",
    name: "의료관련감염 표준예방지침",
    publisher: "질병관리청",
    url: "https://www.kdca.go.kr",
    kind: "guideline",
    access: "free",
    description:
      "손위생, 표준주의, 전파경로별 주의, 기구 관련 감염(요로·혈류·인공호흡기) 예방의 국가 표준. 격리 지침과 개인보호구 착탈의 순서가 여기 기준이다.",
    topics: ["감염관리", "손위생", "격리", "개인보호구", "요로감염", "혈류감염", "무균술"],
  },
  {
    id: "kdca-health-info",
    name: "국가건강정보포털",
    publisher: "질병관리청",
    url: "https://health.kdca.go.kr",
    kind: "guideline",
    access: "free",
    description:
      "질환·증상·검사에 대한 국가 공인 일반 정보. 환자 교육 자료를 만들 때 출처로 쓰기 좋다.",
    topics: ["질환", "환자교육", "검사", "예방"],
  },
  {
    id: "koiha",
    name: "의료기관인증 기준 및 조사항목",
    publisher: "의료기관평가인증원",
    url: "https://www.koiha.or.kr",
    kind: "safety",
    access: "free",
    description:
      "환자확인, 의사소통, 고위험약물, 수술·시술 안전, 낙상·욕창 예방 등 환자안전 활동의 기준. 인증조사 때 실제로 확인받는 항목이라 병원 프로토콜의 뼈대가 된다.",
    topics: ["환자안전", "환자확인", "고위험약물", "인증", "구두처방", "낙상", "욕창"],
  },
  {
    id: "kops",
    name: "환자안전 보고학습시스템 (KOPS)",
    publisher: "의료기관평가인증원",
    url: "https://www.kops.or.kr",
    kind: "safety",
    access: "free",
    description:
      "실제 발생한 환자안전사고 사례와 주의경보를 모아둔 곳. '이런 실수가 이렇게 일어난다'를 사례로 배우기에 가장 좋은 자료다. 보고는 자율적·비처벌이 원칙이다.",
    topics: ["환자안전", "사고사례", "투약오류", "낙상", "주의경보", "보고"],
  },
  {
    id: "mfds-drug",
    name: "의약품안전나라 (의약품통합정보시스템)",
    publisher: "식품의약품안전처",
    url: "https://nedrug.mfds.go.kr",
    kind: "drug",
    access: "free",
    description:
      "국내 허가 의약품의 공식 허가사항과 첨부문서(효능효과·용법용량·금기·부작용) 원문. 낱알 식별과 DUR 정보도 여기서 확인한다. 약 관련 질문의 1차 출처.",
    topics: ["의약품", "허가사항", "금기", "부작용", "DUR", "낱알식별", "용법용량"],
  },
  {
    id: "health-kr",
    name: "약학정보원",
    publisher: "약학정보원",
    url: "https://www.health.kr",
    kind: "drug",
    access: "free",
    description:
      "의약품 상세정보와 복약지도 자료. 허가사항을 실무 언어로 풀어놓아 환자 설명에 바로 쓸 수 있다.",
    topics: ["의약품", "복약지도", "환자교육", "상호작용"],
  },
  {
    id: "kacpr",
    name: "한국형 심폐소생술 가이드라인",
    publisher: "대한심폐소생협회",
    url: "https://www.kacpr.org",
    kind: "guideline",
    access: "free",
    description:
      "국내 BLS·ALS 표준. 압박 깊이·속도, 제세동, 약물 투여 순서의 근거. 5년 주기로 개정되므로 판(version)을 확인하고 봐야 한다.",
    topics: ["심폐소생술", "심정지", "제세동", "응급", "기도확보"],
    caution: "개정 주기가 있다. 병원 교육 자료가 이전 판 기준일 수 있으므로 발행연도를 확인할 것.",
  },
  {
    id: "law-go-kr",
    name: "국가법령정보센터",
    publisher: "법제처",
    url: "https://www.law.go.kr",
    kind: "law",
    access: "free",
    description:
      "의료법, 의료법 시행규칙, 근로기준법, 연명의료결정법, 마약류관리법, 개인정보보호법의 현행 조문. 간호기록 보존기간·업무범위·연명의료 절차처럼 '법으로 정해진 것'은 여기서 원문을 봐야 한다.",
    topics: ["의료법", "근로기준법", "연명의료", "마약류", "개인정보", "간호기록", "업무범위"],
  },
  {
    id: "moel",
    name: "직장 내 괴롭힘 판단 및 예방·대응 매뉴얼 / 노동포털",
    publisher: "고용노동부",
    url: "https://labor.moel.go.kr",
    kind: "rights",
    access: "free",
    description:
      "직장 내 괴롭힘의 정의와 판단 기준, 사례, 신고 절차. 근로기준법 제76조의2~3의 실무 해설서에 해당한다. 온라인 신고도 이 포털에서 한다.",
    topics: ["직장내괴롭힘", "태움", "신고", "근로기준법", "노동상담"],
  },
  {
    id: "knahr",
    name: "간호사 인권센터",
    publisher: "대한간호협회",
    url: "https://www.koreanurse.or.kr",
    kind: "rights",
    access: "free",
    description:
      "간호사 대상 인권침해·괴롭힘 상담과 신고 창구. 소속 병원에 알리지 않고 먼저 상담할 수 있는 통로가 필요할 때 쓴다.",
    topics: ["인권", "태움", "상담", "신고", "간호사"],
  },
  {
    id: "kostom",
    name: "보건의료용어표준 (KOSTOM)",
    publisher: "보건복지부 / 한국보건의료정보원",
    url: "https://www.hins.or.kr",
    kind: "terminology",
    access: "free",
    description:
      "보건복지부 고시로 정해진 국내 보건의료 용어 표준. 간호 행위·관찰·진단 용어의 공식 한글 표기가 여기 있다. 기록에 어떤 표현을 써야 하는지 애매할 때의 기준.",
    topics: ["용어표준", "간호기록", "표기", "코드"],
    caution: "고시 개정에 따라 항목이 바뀐다. 인용할 때 고시 번호와 개정일을 함께 적는다.",
  },
  {
    id: "koicd",
    name: "한국표준질병사인분류 (KCD)",
    publisher: "통계청 / 질병분류정보센터",
    url: "https://www.koicd.kr",
    kind: "terminology",
    access: "free",
    description: "진단명과 질병코드 검색. 인계나 기록에서 만난 진단명의 정확한 표기를 확인할 때.",
    topics: ["진단명", "질병코드", "KCD"],
  },
  {
    id: "kuksiwon",
    name: "간호사 국가시험 출제기준",
    publisher: "한국보건의료인국가시험원",
    url: "https://www.kuksiwon.or.kr",
    kind: "education",
    access: "free",
    description:
      "간호사 국가시험의 공식 출제 범위. 학습 범위를 정할 때 '어디까지가 기본인가'의 기준선으로 쓸 수 있다.",
    topics: ["국가시험", "학습범위", "기본간호"],
  },
  {
    id: "pubmed",
    name: "PubMed",
    publisher: "US National Library of Medicine",
    url: "https://pubmed.ncbi.nlm.nih.gov",
    kind: "research",
    access: "free",
    description:
      "국제 의학·간호학 문헌 검색. 국내 지침에 없는 주제이거나 근거의 원 논문을 확인해야 할 때. 초록은 무료, 전문은 저널에 따라 다르다.",
    topics: ["논문", "근거", "연구", "국제지침"],
  },
  {
    id: "cochrane",
    name: "Cochrane Library",
    publisher: "Cochrane",
    url: "https://www.cochranelibrary.com",
    kind: "research",
    access: "member",
    description:
      "체계적 문헌고찰의 표준. 한 주제에 대해 '지금까지의 근거를 종합하면 무엇이 맞는가'를 볼 수 있다. 국내 대학·병원 도서관 계정으로 접근 가능한 경우가 많다.",
    topics: ["체계적문헌고찰", "근거", "메타분석"],
  },
  {
    id: "msd-manual",
    name: "MSD 매뉴얼 (한국어판)",
    publisher: "Merck & Co.",
    url: "https://www.msdmanuals.com/ko-kr/professional",
    kind: "research",
    access: "free",
    description:
      "질환의 병태생리·진단·치료를 한국어로 정리한 전문가용 참고서. 인계에서 처음 들은 진단명의 큰 그림을 빠르게 잡을 때 유용하다.",
    topics: ["질환", "병태생리", "진단", "치료"],
  },
];

const BY_ID = new Map(OFFICIAL_SOURCES.map((s) => [s.id, s]));

export function getSource(id: string): OfficialSource | undefined {
  return BY_ID.get(id);
}

export function sourcesByKind(kind: SourceKind): OfficialSource[] {
  return OFFICIAL_SOURCES.filter((s) => s.kind === kind);
}

/** 주제 태그로 찾는다. 용어의 `sources`가 비어 있을 때의 대체 경로. */
export function sourcesByTopic(topic: string): OfficialSource[] {
  const t = topic.trim();
  if (!t) return [];
  return OFFICIAL_SOURCES.filter((s) =>
    s.topics.some((x) => x.includes(t) || t.includes(x)),
  );
}

export function searchSources(query: string, limit = 10): OfficialSource[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { source: OfficialSource; rank: number }[] = [];
  for (const s of OFFICIAL_SOURCES) {
    let rank = Infinity;
    if (s.name.toLowerCase().includes(q)) rank = 0;
    else if (s.topics.some((t) => t.toLowerCase().includes(q))) rank = 1;
    else if (s.publisher.toLowerCase().includes(q)) rank = 2;
    else if (s.description.toLowerCase().includes(q)) rank = 3;
    if (rank !== Infinity) scored.push({ source: s, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((x) => x.source);
}

/**
 * 용어 하나에 대해 볼 만한 출처를 고른다.
 * 명시된 `sources`를 우선하고, 없으면 정의·표제어에서 주제를 추정한다.
 */
export function sourcesForTerm(term: {
  sources?: string[];
  ko: string;
  definition: string;
  category: string;
}): OfficialSource[] {
  const out: OfficialSource[] = [];
  const seen = new Set<string>();
  for (const id of term.sources ?? []) {
    const s = BY_ID.get(id);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  if (out.length > 0) return out;

  const haystack = `${term.ko} ${term.definition}`;
  for (const s of OFFICIAL_SOURCES) {
    if (s.topics.some((t) => haystack.includes(t)) && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  if (out.length > 0) return out.slice(0, 3);

  // 마지막 안전망: 카테고리별 기본 출처
  const fallbackByCategory: Record<string, string> = {
    medication: "mfds-drug",
    emergency: "kacpr",
    documentation: "koiha",
    workflow: "koiha",
    shift: "law-go-kr",
    role: "knahr",
  };
  const fallbackId = fallbackByCategory[term.category] ?? "khna-guideline";
  const fallback = BY_ID.get(fallbackId);
  return fallback ? [fallback] : [];
}
