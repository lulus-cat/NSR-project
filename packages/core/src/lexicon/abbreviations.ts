import type { TermCategory } from "./types.js";

/**
 * 병동 약어 대량 테이블.
 *
 * 왜 이 형식이 따로 있는가
 * ----------------------
 * `LexiconEntry`는 정의·주의점·출처까지 갖춘 무거운 구조다. 손으로 정성껏 쓴
 * 백여 개는 그럴 값어치가 있지만, 병동에서 실제로 오가는 약어는 그보다 훨씬 많고
 * 대부분은 "무슨 말인지만 알면 되는" 것들이다. 그런 것까지 전부 무겁게 쓰면
 * 아무도 사전을 안 늘린다.
 *
 * 그래서 여기는 네 칸만 쓴다: 약어 · 영문 · 한글 · 분류.
 * `lexicon/index.ts`가 이걸 `LexiconEntry`로 부풀린다.
 *
 * 한국어 발음형을 안 적는 이유
 * --------------------------
 * 적을 필요가 없다. `expandInitialism`이 "에이비지에이" → ABGA 를 이미 해낸다.
 * 사전에 약어를 한 줄 추가하면 그 한국어 발음형은 **공짜로** 인식된다.
 * 화면에 보여줄 읽기는 `toHangulReading("ABGA")`로 만든다.
 *
 * 중의적인 약어에 대해
 * ------------------
 * `ambiguous: true`가 붙은 것들이 이 표에서 가장 중요하다.
 * D/C(퇴원 vs 투약 중단), SSI(인슐린 vs 수술부위감염), PR(맥박 vs 직장투여) 같은 것들은
 * 신규가 실제로 사고를 내는 지점이다. 뜻을 하나로 정해 주는 대신
 * **둘 다 보여주고 문맥을 확인하라고 말한다.** 앱이 대신 골라 주면 그게 더 위험하다.
 *
 * 정확성에 대해
 * ------------
 * 여기 적힌 것은 국내 병원에서 통용되는 일반적 용법이다. 병원·진료과마다 다르게 쓰는
 * 약어가 있고, 같은 글자가 과에 따라 다른 뜻이 되기도 한다. 실제 기록·투약 판단은
 * 반드시 소속 기관의 약어 목록과 처방 원문을 확인하고 해야 한다.
 */
export interface AbbrevRow {
  /** 대문자 표기. 슬래시·하이픈은 그대로 둔다 (V/S, D/C). */
  abbr: string;
  /** 영문 원말. */
  en: string;
  /** 한국어 뜻. */
  ko: string;
  category: TermCategory;
  /** 문맥에 따라 뜻이 갈리는 약어. 화면에서 경고를 띄운다. */
  ambiguous?: boolean;
  /** 한 줄 덧붙임. */
  note?: string;
}

const A = (
  abbr: string,
  en: string,
  ko: string,
  category: TermCategory,
  extra?: { ambiguous?: boolean; note?: string },
): AbbrevRow => ({ abbr, en, ko, category, ...extra });

/** 활력징후 · 사정 · 신체계측 */
export const ASSESSMENT_ABBREVS: AbbrevRow[] = [
  A("BP", "blood pressure", "혈압", "assessment"),
  A("SBP", "systolic blood pressure", "수축기 혈압", "assessment"),
  A("DBP", "diastolic blood pressure", "이완기 혈압", "assessment"),
  A("MAP", "mean arterial pressure", "평균 동맥압", "assessment"),
  A("NIBP", "non-invasive blood pressure", "비침습적 혈압", "assessment"),
  A("HR", "heart rate", "심박수", "assessment"),
  A("PR", "pulse rate / per rectum", "맥박수 / 직장 투여", "assessment", {
    ambiguous: true,
    note: "활력징후 칸이면 맥박, 투약 경로 칸이면 직장 투여다. 칸을 보고 판단한다.",
  }),
  A("RR", "respiratory rate / recovery room", "호흡수 / 회복실", "assessment", {
    ambiguous: true,
    note: "활력징후에서는 호흡수, 수술 관련 문맥에서는 회복실이다.",
  }),
  A("BT", "body temperature", "체온", "assessment"),
  A("TPR", "temperature, pulse, respiration", "체온·맥박·호흡", "assessment"),
  A("SpO2", "peripheral oxygen saturation", "말초 산소포화도", "assessment"),
  A("SaO2", "arterial oxygen saturation", "동맥혈 산소포화도", "assessment"),
  A("EtCO2", "end-tidal carbon dioxide", "호기말 이산화탄소", "assessment"),
  A("CVP", "central venous pressure", "중심정맥압", "assessment"),
  A("ICP", "intracranial pressure", "두개내압", "assessment"),
  A("IAP", "intra-abdominal pressure", "복강내압", "assessment"),
  A("CO", "cardiac output", "심박출량", "assessment"),
  A("EF", "ejection fraction", "박출률", "assessment"),
  A("CRT", "capillary refill time", "모세혈관 재충전 시간", "assessment"),
  A("BW", "body weight", "체중", "assessment"),
  A("IBW", "ideal body weight", "이상 체중", "assessment"),
  A("BMI", "body mass index", "체질량지수", "assessment"),
  A("BSA", "body surface area", "체표면적", "assessment"),
  A("LOC", "level of consciousness", "의식 수준", "assessment"),
  A("GCS", "Glasgow Coma Scale", "글래스고 혼수 척도", "assessment"),
  A("AVPU", "alert, verbal, pain, unresponsive", "의식 4단계 평가", "assessment"),
  A("MMSE", "Mini-Mental State Examination", "간이 정신상태 검사", "assessment"),
  A("CAM-ICU", "Confusion Assessment Method for the ICU", "중환자 섬망 평가도구", "assessment"),
  A("RASS", "Richmond Agitation-Sedation Scale", "진정·초조 척도", "assessment"),
  A("NRS", "Numeric Rating Scale", "숫자 통증등급", "assessment"),
  A("VAS", "Visual Analogue Scale", "시각 통증등급", "assessment"),
  A("FLACC", "Face, Legs, Activity, Cry, Consolability", "소아 행동 통증척도", "assessment"),
  A("MFS", "Morse Fall Scale", "낙상위험 사정도구", "assessment"),
  A("ADL", "activities of daily living", "일상생활수행능력", "assessment"),
  A("IADL", "instrumental activities of daily living", "수단적 일상생활수행능력", "assessment"),
  A("ROM", "range of motion", "관절가동범위", "assessment"),
  A("DTR", "deep tendon reflex", "심부건반사", "assessment"),
  A("EOM", "extraocular movement", "안구운동", "assessment"),
  A("PERRLA", "pupils equal, round, reactive to light and accommodation", "동공 반응 정상", "assessment"),
  A("JVP", "jugular venous pressure", "경정맥압", "assessment"),
  A("MEWS", "Modified Early Warning Score", "조기경보점수", "assessment"),
  A("NEWS", "National Early Warning Score", "조기경보점수(국가표준)", "assessment"),
  A("BST", "blood sugar test", "혈당검사", "assessment"),
  A("FBS", "fasting blood sugar", "공복 혈당", "assessment"),
  A("PP2", "postprandial 2 hours", "식후 2시간 혈당", "assessment"),
  A("I/O", "intake and output", "섭취량/배설량", "assessment"),
  A("UO", "urine output", "소변량", "assessment"),
  A("NPO", "nil per os", "금식", "assessment"),
];

/** 진단검사 · 영상검사 */
export const LAB_ABBREVS: AbbrevRow[] = [
  A("CBC", "complete blood count", "일반혈액검사", "lab"),
  A("WBC", "white blood cell", "백혈구", "lab"),
  A("RBC", "red blood cell", "적혈구", "lab"),
  A("Hb", "hemoglobin", "혈색소", "lab"),
  A("Hct", "hematocrit", "적혈구용적률", "lab"),
  A("PLT", "platelet", "혈소판", "lab"),
  A("ANC", "absolute neutrophil count", "절대호중구수", "lab", {
    note: "500 미만이면 호중구감소증. 발열 자체가 응급이다.",
  }),
  A("ESR", "erythrocyte sedimentation rate", "적혈구침강속도", "lab"),
  A("CRP", "C-reactive protein", "C-반응성 단백", "lab"),
  A("PCT", "procalcitonin", "프로칼시토닌", "lab"),
  A("BUN", "blood urea nitrogen", "혈중요소질소", "lab"),
  A("Cr", "creatinine", "크레아티닌", "lab"),
  A("GFR", "glomerular filtration rate", "사구체여과율", "lab"),
  A("eGFR", "estimated glomerular filtration rate", "추정 사구체여과율", "lab"),
  A("AST", "aspartate aminotransferase", "간효소(AST)", "lab"),
  A("ALT", "alanine aminotransferase", "간효소(ALT)", "lab"),
  A("ALP", "alkaline phosphatase", "알칼리성 인산분해효소", "lab"),
  A("GGT", "gamma-glutamyl transferase", "감마지티피", "lab"),
  A("TB", "total bilirubin / tuberculosis", "총빌리루빈 / 결핵", "lab", {
    ambiguous: true,
    note: "간기능 검사 묶음이면 총빌리루빈, 감염·격리 문맥이면 결핵이다.",
  }),
  A("DB", "direct bilirubin", "직접빌리루빈", "lab"),
  A("Alb", "albumin", "알부민", "lab"),
  A("TP", "total protein", "총단백", "lab"),
  A("Na", "sodium", "나트륨", "lab"),
  A("K", "potassium", "칼륨", "lab", {
    note: "이상 시 치명적 부정맥으로 이어진다. 결과가 크게 벗어나면 즉시 보고 대상.",
  }),
  A("Cl", "chloride", "염소", "lab"),
  A("Ca", "calcium", "칼슘", "lab"),
  A("Mg", "magnesium", "마그네슘", "lab"),
  A("Phos", "phosphorus", "인", "lab"),
  A("TG", "triglyceride", "중성지방", "lab"),
  A("TC", "total cholesterol", "총콜레스테롤", "lab"),
  A("HDL", "high-density lipoprotein", "고밀도 지단백", "lab"),
  A("LDL", "low-density lipoprotein", "저밀도 지단백", "lab"),
  A("HbA1c", "glycated hemoglobin", "당화혈색소", "lab"),
  A("PT", "prothrombin time / physical therapy", "프로트롬빈시간 / 물리치료", "lab", {
    ambiguous: true,
    note: "검사 묶음이면 응고검사, 재활 문맥이면 물리치료다.",
  }),
  A("INR", "international normalized ratio", "국제표준화비율", "lab"),
  A("aPTT", "activated partial thromboplastin time", "활성화 부분트롬보플라스틴시간", "lab"),
  A("FDP", "fibrin degradation product", "피브린 분해산물", "lab"),
  A("Fib", "fibrinogen", "피브리노겐", "lab"),
  A("ABGA", "arterial blood gas analysis", "동맥혈가스분석", "lab"),
  A("PaO2", "partial pressure of arterial oxygen", "동맥혈 산소분압", "lab"),
  A("PaCO2", "partial pressure of arterial carbon dioxide", "동맥혈 이산화탄소분압", "lab"),
  A("HCO3", "bicarbonate", "중탄산염", "lab"),
  A("BE", "base excess", "염기과잉", "lab"),
  A("Lac", "lactate", "젖산", "lab"),
  A("CK", "creatine kinase", "크레아틴 키나아제", "lab"),
  A("CK-MB", "creatine kinase-MB", "심근 효소(CK-MB)", "lab"),
  A("LDH", "lactate dehydrogenase", "젖산탈수소효소", "lab"),
  A("BNP", "brain natriuretic peptide", "뇌나트륨이뇨펩타이드", "lab"),
  A("TSH", "thyroid stimulating hormone", "갑상선자극호르몬", "lab"),
  A("T3", "triiodothyronine", "삼요오드타이로닌", "lab"),
  A("T4", "thyroxine", "티록신", "lab"),
  A("PSA", "prostate-specific antigen", "전립선특이항원", "lab"),
  A("CEA", "carcinoembryonic antigen", "암배아항원", "lab"),
  A("AFP", "alpha-fetoprotein", "알파태아단백", "lab"),
  A("UA", "urinalysis / uric acid", "소변검사 / 요산", "lab", { ambiguous: true }),
  A("C/S", "culture and sensitivity", "배양 및 항생제감수성검사", "lab", {
    note: "항생제 투여 '전'에 채취해야 의미가 있다.",
  }),
  A("AFB", "acid-fast bacilli", "항산균 검사", "lab"),
  A("PCR", "polymerase chain reaction", "중합효소연쇄반응", "lab"),
  A("HBsAg", "hepatitis B surface antigen", "B형간염 표면항원", "lab"),
  A("ANA", "antinuclear antibody", "항핵항체", "lab"),
  A("RF", "rheumatoid factor", "류마티스 인자", "lab"),
  A("LFT", "liver function test", "간기능검사", "lab"),
  A("RFT", "renal function test", "신기능검사", "lab"),
  A("TFT", "thyroid function test", "갑상선기능검사", "lab"),
  A("EKG", "electrocardiogram", "심전도", "lab"),
  A("ECG", "electrocardiogram", "심전도", "lab"),
  A("EEG", "electroencephalogram", "뇌파검사", "lab"),
  A("EMG", "electromyogram", "근전도", "lab"),
  A("CXR", "chest X-ray", "흉부 방사선촬영", "lab"),
  A("KUB", "kidney, ureter, bladder X-ray", "복부 단순촬영", "lab"),
  A("CT", "computed tomography", "컴퓨터단층촬영", "lab"),
  A("MRI", "magnetic resonance imaging", "자기공명영상", "lab"),
  A("MRA", "magnetic resonance angiography", "자기공명혈관조영", "lab"),
  A("US", "ultrasonography", "초음파검사", "lab"),
  A("TTE", "transthoracic echocardiography", "경흉부 심초음파", "lab"),
  A("TEE", "transesophageal echocardiography", "경식도 심초음파", "lab"),
  A("PFT", "pulmonary function test", "폐기능검사", "lab"),
  A("EGD", "esophagogastroduodenoscopy", "위내시경", "lab"),
  A("ERCP", "endoscopic retrograde cholangiopancreatography", "내시경적 역행성 담췌관조영술", "lab"),
  A("PET", "positron emission tomography", "양전자단층촬영", "lab"),
  A("BMD", "bone mineral density", "골밀도검사", "lab"),
  A("PCI", "percutaneous coronary intervention", "경피적 관상동맥중재술", "lab"),
  A("CAG", "coronary angiography", "관상동맥조영술", "lab"),
];

/** 투약 · 경로 · 시간 지시 */
export const MEDICATION_ABBREVS: AbbrevRow[] = [
  A("PO", "per os", "경구 투여", "medication"),
  A("IV", "intravenous", "정맥 투여", "medication"),
  A("IM", "intramuscular", "근육 투여", "medication"),
  A("SC", "subcutaneous", "피하 투여", "medication"),
  A("SQ", "subcutaneous", "피하 투여", "medication"),
  A("ID", "intradermal", "피내 투여", "medication"),
  A("SL", "sublingual", "설하 투여", "medication"),
  A("IVF", "intravenous fluid", "정맥 수액", "medication"),
  A("IVS", "intravenous side injection", "정맥 측관 주입", "medication"),
  A("IVP", "intravenous push", "정맥 직접 주입", "medication"),
  A("PRN", "pro re nata", "필요시 투여", "medication"),
  A("STAT", "statim", "즉시 투여", "medication"),
  A("QD", "quaque die", "하루 한 번", "medication"),
  A("BID", "bis in die", "하루 두 번", "medication"),
  A("TID", "ter in die", "하루 세 번", "medication"),
  A("QID", "quater in die", "하루 네 번", "medication"),
  A("QOD", "quaque altera die", "격일", "medication"),
  A("HS", "hora somni", "취침 전", "medication"),
  A("AC", "ante cibum", "식전", "medication"),
  A("PC", "post cibum", "식후", "medication"),
  A("MN", "midnight", "자정", "medication"),
  A("NS", "normal saline", "생리식염수", "medication"),
  A("DW", "dextrose water", "포도당 수액", "medication"),
  A("HS-D", "half saline dextrose", "하프세이린 포도당", "medication"),
  A("KCl", "potassium chloride", "염화칼륨", "medication", {
    note: "고농도 원액 정맥주사 절대 금지. 반드시 희석한다. 고위험약물.",
  }),
  A("NaCl", "sodium chloride", "염화나트륨", "medication"),
  A("MgSO4", "magnesium sulfate", "황산마그네슘", "medication"),
  A("NaHCO3", "sodium bicarbonate", "탄산수소나트륨", "medication"),
  A("TPN", "total parenteral nutrition", "완전비경구영양", "medication"),
  A("PPN", "peripheral parenteral nutrition", "말초정맥영양", "medication"),
  A("ABX", "antibiotics", "항생제", "medication"),
  A("NSAID", "non-steroidal anti-inflammatory drug", "비스테로이드성 소염진통제", "medication"),
  A("PPI", "proton pump inhibitor", "양성자펌프억제제", "medication"),
  A("CCB", "calcium channel blocker", "칼슘통로차단제", "medication"),
  A("ARB", "angiotensin receptor blocker", "안지오텐신 수용체 차단제", "medication"),
  A("LMWH", "low molecular weight heparin", "저분자량 헤파린", "medication"),
  A("UFH", "unfractionated heparin", "미분획 헤파린", "medication"),
  A("DOAC", "direct oral anticoagulant", "직접 경구 항응고제", "medication"),
  A("OHA", "oral hypoglycemic agent", "경구 혈당강하제", "medication"),
  A("RI", "regular insulin", "속효성 인슐린", "medication"),
  A("NPH", "neutral protamine Hagedorn insulin", "중간형 인슐린", "medication"),
  A("SSI", "sliding scale insulin / surgical site infection", "혈당표 인슐린 / 수술부위감염", "medication", {
    ambiguous: true,
    note: "투약 문맥이면 인슐린, 감염관리 문맥이면 수술부위감염이다. 잘못 읽으면 사고로 직결된다.",
  }),
  A("PCA", "patient-controlled analgesia", "자가통증조절장치", "medication"),
  A("ADR", "adverse drug reaction", "약물유해반응", "medication"),
  A("DUR", "drug utilization review", "의약품안전사용서비스", "medication"),
  A("D/C", "discharge / discontinue", "퇴원 / 중단", "medication", {
    ambiguous: true,
    note: "환자 D/C는 퇴원, 라인·약 D/C는 중단이다. 신규가 가장 자주 헷갈리는 약어.",
  }),
  A("KVO", "keep vein open", "혈관 유지 속도", "medication"),
  A("TKO", "to keep open", "혈관 유지 속도", "medication"),
  A("gtt", "guttae (drops)", "방울/분당 점적수", "medication"),
];

/** 처치 · 기구 · 라인 */
export const DEVICE_ABBREVS: AbbrevRow[] = [
  A("L-tube", "Levin tube", "비위관", "device"),
  A("NG", "nasogastric tube", "비위관", "device"),
  A("OG", "orogastric tube", "구위관", "device"),
  A("PEG", "percutaneous endoscopic gastrostomy", "경피내시경 위루술", "device"),
  A("CVC", "central venous catheter", "중심정맥관", "device"),
  A("PICC", "peripherally inserted central catheter", "말초삽입 중심정맥관", "device"),
  A("ETT", "endotracheal tube", "기관내관", "device"),
  A("T-cannula", "tracheostomy cannula", "기관절개관", "device"),
  A("JP", "Jackson-Pratt drain", "제이피 배액관", "device"),
  A("PTBD", "percutaneous transhepatic biliary drainage", "경피경간 담도배액술", "device"),
  A("PCN", "percutaneous nephrostomy", "경피적 신루술", "device"),
  A("ICD", "implantable cardioverter defibrillator", "삽입형 제세동기", "device"),
  A("PM", "pacemaker", "인공심박동기", "device"),
  A("CRRT", "continuous renal replacement therapy", "지속적 신대체요법", "device"),
  A("HD", "hemodialysis / hospital day", "혈액투석 / 재원일수", "device", {
    ambiguous: true,
    note: "투석실·신장내과 문맥이면 혈액투석, 기록 머리말의 'HD #3'이면 재원 3일째다.",
  }),
  A("PD", "peritoneal dialysis", "복막투석", "device"),
  A("ECMO", "extracorporeal membrane oxygenation", "체외막산소공급", "device"),
  A("IABP", "intra-aortic balloon pump", "대동맥내 풍선펌프", "device"),
  A("BVM", "bag valve mask", "수동식 인공호흡기", "device"),
  A("NRM", "non-rebreather mask", "비재호흡 마스크", "device"),
  A("HFNC", "high flow nasal cannula", "고유량 비강캐뉼라", "device"),
  A("CPAP", "continuous positive airway pressure", "지속기도양압", "device"),
  A("BiPAP", "bilevel positive airway pressure", "이중기도양압", "device"),
  A("MV", "mechanical ventilation", "기계환기", "device"),
  A("SIMV", "synchronized intermittent mandatory ventilation", "동기화 간헐적 강제환기", "device"),
  A("PSV", "pressure support ventilation", "압력보조환기", "device"),
  A("PEEP", "positive end-expiratory pressure", "호기말 양압", "device"),
  A("FiO2", "fraction of inspired oxygen", "흡입산소분율", "device"),
  A("TV", "tidal volume", "일회호흡량", "device"),
  A("SCD", "sequential compression device", "간헐적 공기압박장치", "device"),
  A("TED", "thromboembolic deterrent stocking", "혈전예방 스타킹", "device"),
  A("IS", "incentive spirometer", "강화폐활량계", "device"),
];

/** 진단 · 상태 */
export const CONDITION_ABBREVS: AbbrevRow[] = [
  A("DM", "diabetes mellitus", "당뇨병", "condition"),
  A("HTN", "hypertension", "고혈압", "condition"),
  A("CAD", "coronary artery disease", "관상동맥질환", "condition"),
  A("MI", "myocardial infarction", "심근경색", "condition"),
  A("AMI", "acute myocardial infarction", "급성 심근경색", "condition"),
  A("STEMI", "ST-elevation myocardial infarction", "ST분절상승 심근경색", "condition"),
  A("NSTEMI", "non-ST-elevation myocardial infarction", "비ST분절상승 심근경색", "condition"),
  A("CHF", "congestive heart failure", "울혈성 심부전", "condition"),
  A("AF", "atrial fibrillation", "심방세동", "condition"),
  A("SVT", "supraventricular tachycardia", "상심실성 빈맥", "condition"),
  A("VT", "ventricular tachycardia", "심실빈맥", "condition"),
  A("VF", "ventricular fibrillation", "심실세동", "condition"),
  A("PVC", "premature ventricular contraction", "심실조기수축", "condition"),
  A("PAC", "premature atrial contraction", "심방조기수축", "condition"),
  A("CVA", "cerebrovascular accident", "뇌졸중", "condition"),
  A("ICH", "intracerebral hemorrhage", "뇌내출혈", "condition"),
  A("SAH", "subarachnoid hemorrhage", "지주막하출혈", "condition"),
  A("SDH", "subdural hemorrhage", "경막하출혈", "condition"),
  A("EDH", "epidural hemorrhage", "경막외출혈", "condition"),
  A("TIA", "transient ischemic attack", "일과성 허혈발작", "condition"),
  A("COPD", "chronic obstructive pulmonary disease", "만성폐쇄성폐질환", "condition"),
  A("PNA", "pneumonia", "폐렴", "condition"),
  A("ARDS", "acute respiratory distress syndrome", "급성호흡곤란증후군", "condition"),
  A("PE", "pulmonary embolism / physical examination", "폐색전증 / 신체검진", "condition", {
    ambiguous: true,
  }),
  A("DVT", "deep vein thrombosis", "심부정맥혈전증", "condition"),
  A("CKD", "chronic kidney disease", "만성콩팥병", "condition"),
  A("ESRD", "end-stage renal disease", "말기신부전", "condition"),
  A("AKI", "acute kidney injury", "급성 신손상", "condition"),
  A("LC", "liver cirrhosis", "간경변", "condition"),
  A("HCC", "hepatocellular carcinoma", "간세포암", "condition"),
  A("AP", "acute pancreatitis / assessment and plan", "급성 췌장염 / 사정과 계획", "condition", {
    ambiguous: true,
  }),
  A("UGIB", "upper gastrointestinal bleeding", "상부위장관 출혈", "condition"),
  A("LGIB", "lower gastrointestinal bleeding", "하부위장관 출혈", "condition"),
  A("IBD", "inflammatory bowel disease", "염증성 장질환", "condition"),
  A("UTI", "urinary tract infection", "요로감염", "condition"),
  A("BPH", "benign prostatic hyperplasia", "전립선비대증", "condition"),
  A("RA", "rheumatoid arthritis", "류마티스 관절염", "condition"),
  A("OA", "osteoarthritis", "골관절염", "condition"),
  A("SLE", "systemic lupus erythematosus", "전신홍반루푸스", "condition"),
  A("HIVD", "herniated intervertebral disc", "추간판탈출증", "condition"),
  A("Fx", "fracture", "골절", "condition"),
  A("DIC", "disseminated intravascular coagulation", "파종성 혈관내응고", "condition"),
  A("MODS", "multiple organ dysfunction syndrome", "다발성 장기부전", "condition"),
  A("SIRS", "systemic inflammatory response syndrome", "전신염증반응증후군", "condition"),
  A("DKA", "diabetic ketoacidosis", "당뇨병성 케톤산증", "condition"),
  A("HHS", "hyperosmolar hyperglycemic state", "고삼투압 고혈당 상태", "condition"),
  A("N/V", "nausea and vomiting", "오심과 구토", "condition"),
  A("SOB", "shortness of breath", "호흡곤란", "condition"),
  A("LOM", "limitation of motion", "운동 제한", "condition"),
  A("BBS", "bilateral breath sounds", "양측 호흡음", "condition"),
];

/** 감염관리 */
export const INFECTION_ABBREVS: AbbrevRow[] = [
  A("HAI", "healthcare-associated infection", "의료관련감염", "procedure"),
  A("MRSA", "methicillin-resistant Staphylococcus aureus", "메티실린내성 황색포도알균", "procedure"),
  A("VRE", "vancomycin-resistant Enterococcus", "반코마이신내성 장알균", "procedure"),
  A("CRE", "carbapenem-resistant Enterobacteriaceae", "카바페넴내성 장내세균", "procedure"),
  A("CPE", "carbapenemase-producing Enterobacteriaceae", "카바페넴분해효소 생성 장내세균", "procedure"),
  A("MDRO", "multidrug-resistant organism", "다제내성균", "procedure"),
  A("ESBL", "extended-spectrum beta-lactamase", "광범위 베타락탐분해효소", "procedure"),
  A("CDI", "Clostridioides difficile infection", "클로스트리디오이데스 디피실 감염", "procedure"),
  A("PPE", "personal protective equipment", "개인보호구", "procedure"),
  A("AIIR", "airborne infection isolation room", "공기감염 격리실", "procedure"),
  A("CLABSI", "central line-associated bloodstream infection", "중심정맥관 관련 혈류감염", "procedure"),
  A("CAUTI", "catheter-associated urinary tract infection", "유치도뇨관 관련 요로감염", "procedure"),
  A("VAP", "ventilator-associated pneumonia", "인공호흡기 관련 폐렴", "procedure"),
  A("HH", "hand hygiene", "손위생", "procedure"),
];

/** 기록 · 보고 · 부서 · 업무 */
export const WORKFLOW_ABBREVS: AbbrevRow[] = [
  A("EMR", "electronic medical record", "전자의무기록", "documentation"),
  A("OCS", "order communication system", "처방전달시스템", "documentation"),
  A("PACS", "picture archiving and communication system", "의료영상저장전송시스템", "documentation"),
  A("SOAP", "subjective, objective, assessment, plan", "주관적·객관적·사정·계획 기록형식", "documentation"),
  A("SBAR", "situation, background, assessment, recommendation", "상황·배경·사정·제안 보고형식", "documentation"),
  A("DAR", "data, action, response", "자료·중재·반응 기록형식", "documentation"),
  A("VO", "verbal order", "구두처방", "documentation"),
  A("TO", "telephone order", "전화처방", "documentation"),
  A("Rx", "prescription / treatment", "처방", "documentation"),
  A("Tx", "treatment", "치료", "documentation"),
  A("Dx", "diagnosis", "진단", "documentation"),
  A("Sx", "symptom", "증상", "documentation"),
  A("Hx", "history", "병력", "documentation"),
  A("PMHx", "past medical history", "과거병력", "documentation"),
  A("FHx", "family history", "가족력", "documentation"),
  A("ROS", "review of systems", "계통별 문진", "documentation"),
  A("C/C", "chief complaint", "주호소", "documentation"),
  A("PI", "present illness", "현병력", "documentation"),
  A("R/O", "rule out", "감별 대상(배제 요함)", "documentation"),
  A("F/U", "follow up", "추적 관찰", "documentation"),
  A("NANDA", "NANDA International nursing diagnosis", "간호진단 분류체계", "documentation"),
  A("NIC", "Nursing Interventions Classification", "간호중재 분류체계", "documentation"),
  A("NOC", "Nursing Outcomes Classification", "간호결과 분류체계", "documentation"),
  A("KCD", "Korean Standard Classification of Diseases", "한국표준질병사인분류", "documentation"),
  A("IC", "informed consent", "설명 후 동의", "documentation"),
  A("DNR", "do not resuscitate", "심폐소생술금지", "documentation"),
  A("DNAR", "do not attempt resuscitation", "심폐소생술 시도 금지", "documentation"),
  A("POD", "post-operative day", "수술 후 경과일", "documentation"),
  A("LOS", "length of stay", "재원기간", "documentation"),
  A("OPD", "outpatient department", "외래", "workflow"),
  A("ER", "emergency room", "응급실", "workflow"),
  A("ED", "emergency department", "응급실", "workflow"),
  A("ICU", "intensive care unit", "중환자실", "workflow"),
  A("MICU", "medical intensive care unit", "내과계 중환자실", "workflow"),
  A("SICU", "surgical intensive care unit", "외과계 중환자실", "workflow"),
  A("NICU", "neonatal intensive care unit", "신생아 중환자실", "workflow"),
  A("CCU", "coronary care unit", "심장계 중환자실", "workflow"),
  A("GW", "general ward", "일반병동", "workflow"),
  A("OR", "operating room", "수술실", "workflow"),
  A("PACU", "post-anesthesia care unit", "마취회복실", "workflow"),
  A("OP", "operation", "수술", "workflow"),
  A("ADM", "admission", "입원", "workflow"),
  A("TRF", "transfer", "전동", "workflow"),
  A("RRT", "rapid response team", "신속대응팀", "emergency"),
  A("CPR", "cardiopulmonary resuscitation", "심폐소생술", "emergency"),
  A("ROSC", "return of spontaneous circulation", "자발순환 회복", "emergency"),
  A("BLS", "basic life support", "기본소생술", "emergency"),
  A("ACLS", "advanced cardiovascular life support", "전문심장소생술", "emergency"),
  A("KALS", "Korean advanced life support", "한국형 전문소생술", "emergency"),
  A("NRP", "neonatal resuscitation program", "신생아소생술", "emergency"),
  A("TTM", "targeted temperature management", "목표체온유지치료", "emergency"),
  A("AED", "automated external defibrillator", "자동제세동기", "emergency"),
];

/** 전체 약어 표. */
export const ALL_ABBREVS: AbbrevRow[] = [
  ...ASSESSMENT_ABBREVS,
  ...LAB_ABBREVS,
  ...MEDICATION_ABBREVS,
  ...DEVICE_ABBREVS,
  ...CONDITION_ABBREVS,
  ...INFECTION_ABBREVS,
  ...WORKFLOW_ABBREVS,
];
