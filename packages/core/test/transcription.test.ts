import { describe, it, expect } from "vitest";
import {
  correctTranscript,
  buildInitialPrompt,
  buildHotwords,
  buildKeywordBoosting,
  buildCorrectionRulesForLLM,
  estimateWhisperTokens,
  WHISPER_PROMPT_TOKEN_LIMIT,
  createMemory,
  recordCorrection,
  lookupLearned,
  pendingRules,
  pruneMemory,
  deidentify,
} from "../src/transcription/index.js";
import { defaultLexicon } from "../src/lexicon/index.js";

describe("전사 교정", () => {
  it("한글로 읽은 약어를 영문 약어로 되돌린다", () => {
    const r = correctTranscript("브이에스 체크했어?");
    expect(r.text).toContain("V/S");
    expect(r.edits[0]?.reason).toBe("initialism");
  });

  it("화자가 실제로 쓴 은어는 바꾸지 않고 주석만 단다", () => {
    const r = correctTranscript("폴리 소변량 확인해");
    expect(r.text).toContain("폴리");
    expect(r.text).not.toContain("유치도뇨관");
    expect(r.termIds).toContain("foley-catheter");
    expect(r.edits.filter((e) => e.entryId === "foley-catheter")).toHaveLength(0);
  });

  it("사전에 등록된 오인식 표기를 원래 말로 되돌린다", () => {
    const r = correctTranscript("노디 먼저 드려");
    expect(r.text).toContain("노티");
    expect(r.edits.find((e) => e.entryId === "notify")?.reason).toBe("misheard");
  });

  it("사전에 없는 오인식도 발음이 충분히 가까우면 교정한다", () => {
    const r = correctTranscript("드레씽 다시 했어요");
    expect(r.text).toContain("드레싱");
    expect(r.edits.find((e) => e.entryId === "dressing")?.reason).toBe("phonetic");
  });

  it("오인식 교정의 목적지는 다른 오인식 표기가 아니다", () => {
    // "포리"(오인식) → "폴리"(실제 발화)로 가야지 "폴리카데터"(오인식)로 가면 안 된다.
    const r = correctTranscript("포리 유지 중이에요");
    expect(r.text).toContain("폴리");
    expect(r.text).not.toContain("카데");
  });

  it("조사가 붙은 어절에서도 용어를 찾는다", () => {
    const r = correctTranscript("석션을 먼저 하고 드레싱했어요");
    expect(r.termIds).toContain("suction");
    expect(r.termIds).toContain("dressing");
  });

  it("원문을 항상 보존한다", () => {
    const input = "브이에스 체크";
    const r = correctTranscript(input);
    expect(r.original).toBe(input);
    expect(r.text).not.toBe(input);
  });

  it("abbreviationStyle keep이면 원문 표기를 유지한다", () => {
    const r = correctTranscript("브이에스 체크", { abbreviationStyle: "keep" });
    expect(r.text).toContain("브이에스");
    expect(r.edits).toHaveLength(0);
    expect(r.termIds).toContain("vital-sign");
  });

  it("사전에 없는 문장은 그대로 둔다", () => {
    const input = "오늘 점심 뭐 먹었어요";
    expect(correctTranscript(input).text).toBe(input);
  });

  it("주석 위치가 교정 후 텍스트를 정확히 가리킨다", () => {
    const r = correctTranscript("아침에 브이에스 체크하고 석션했어요");
    for (const ann of r.annotations) {
      expect(r.text.slice(ann.start, ann.end)).toBe(ann.surface);
    }
  });

  it("여러 용어가 든 인계 문장을 처리한다", () => {
    const r = correctTranscript(
      "엔피오 유지하고 아이오 정확히 재고 디엔알 동의서 확인해주세요",
    );
    expect(r.termIds).toEqual(
      expect.arrayContaining(["npo", "intake-output", "dnr"]),
    );
  });
});

describe("Whisper 프롬프트 생성", () => {
  it("토큰 예산을 넘지 않는다", () => {
    const prompt = buildInitialPrompt(defaultLexicon);
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(
      WHISPER_PROMPT_TOKEN_LIMIT,
    );
  });

  it("사용 이력이 있는 용어를 뒤쪽(=살아남는 자리)에 배치한다", () => {
    const prompt = buildInitialPrompt(defaultLexicon, {
      usageCounts: { "night-shift": 50 },
    });
    expect(prompt).toContain("나이트");
  });

  it("pinned 용어는 반드시 포함된다", () => {
    const prompt = buildInitialPrompt(defaultLexicon, { pinned: ["braden-scale"] });
    expect(prompt).toContain("욕창위험 사정도구");
  });

  it("hotwords는 상한을 지킨다", () => {
    expect(buildHotwords(defaultLexicon, { limit: 10 })).toHaveLength(10);
  });
});

describe("사용자 교정 학습", () => {
  it("최소 횟수를 넘어야 자동 적용된다", () => {
    let m = createMemory(2);
    m = recordCorrection(m, "쎅션", "석션", 1);
    expect(lookupLearned(m)).toHaveLength(0);
    expect(pendingRules(m)).toHaveLength(1);
    m = recordCorrection(m, "쎅션", "석션", 2);
    expect(lookupLearned(m)).toHaveLength(1);
  });

  it("학습된 규칙이 교정에 적용된다", () => {
    let m = createMemory(2);
    m = recordCorrection(m, "완전실", "환자실", 1);
    m = recordCorrection(m, "완전실", "환자실", 2);
    const r = correctTranscript("완전실 정리해주세요", { memory: m });
    expect(r.text).toContain("환자실");
    expect(r.edits.some((e) => e.reason === "learned")).toBe(true);
  });

  it("문장 길이의 교정은 규칙으로 학습하지 않는다", () => {
    const m = recordCorrection(
      createMemory(1),
      "오늘 근무 중에 있었던 모든 일을 정리해주세요",
      "정리",
      1,
    );
    expect(Object.keys(m.rules)).toHaveLength(0);
  });

  it("오래된 규칙을 정리한다", () => {
    let m = createMemory(1);
    m = recordCorrection(m, "가", "나", 1000);
    m = recordCorrection(m, "다", "라", 9000);
    const pruned = pruneMemory(m, { olderThan: 5000 });
    expect(Object.keys(pruned.rules)).toHaveLength(1);
  });
});

describe("비식별화", () => {
  it("등록번호·전화번호·이름 앞 호칭을 가린다", () => {
    const r = deidentify("김영희님 등록번호 12345678, 연락처 010-1234-5678");
    expect(r.text).toContain("[이름]");
    expect(r.text).toContain("[등록번호]");
    expect(r.text).toContain("[전화번호]");
    expect(r.redactedCount).toBeGreaterThanOrEqual(3);
  });
});

describe("상용 엔진 키워드 부스팅", () => {
  it("한글 형태만 내보낸다", () => {
    // 상용 엔진의 부스팅은 한국어만 받고, 애초에 오디오에 영문 약어 소리는 없다.
    for (const k of buildKeywordBoosting(defaultLexicon, { limit: 300 })) {
      expect(/[가-힣]/.test(k.keyword), `한글 아님: ${k.keyword}`).toBe(true);
    }
  });

  it("약어는 한국어 읽기형으로 바꿔 넣는다", () => {
    const keywords = buildKeywordBoosting(defaultLexicon).map((k) => k.keyword);
    expect(keywords).toContain("에이비지에이");
    expect(keywords).not.toContain("ABGA");
  });

  it("중복 없이 상한을 지킨다", () => {
    const k = buildKeywordBoosting(defaultLexicon, { limit: 50 });
    expect(k).toHaveLength(50);
    expect(new Set(k.map((x) => x.keyword)).size).toBe(50);
  });

  it("자주 나온 용어에만 가중치를 올린다", () => {
    const k = buildKeywordBoosting(defaultLexicon, {
      usageCounts: { "night-shift": 20 },
    });
    expect(k.find((x) => x.keyword === "나이트")?.weight).toBe(3);
    // 이력이 없는 것은 기본 가중치 그대로. 세게 주면 없는 말을 만들어낸다.
    expect(k.find((x) => x.keyword === "브레이든")?.weight).toBe(1);
  });
});

describe("조사 절단의 한계 — 낱말의 앞부분만 용어로 잡아서는 안 된다", () => {
  it("'티오티'의 앞 두 글자를 약어 TO 로 바꾸지 않는다", () => {
    // 어절 꼬리를 조사로 보고 잘라내는 규칙이 '티'를 조사로 오인한 사고.
    // 꼬리는 실제 조사·어미로 시작할 때만 잘라낸다.
    const r = correctTranscript("티오티 확인했어요");
    expect(r.text).toBe("티오티 확인했어요");
    expect(r.edits).toHaveLength(0);
  });

  it("진짜 조사·어미가 붙은 것은 여전히 잡는다", () => {
    expect(correctTranscript("폴리를 뺐어요").termIds).toContain("foley-catheter");
    expect(correctTranscript("석션했어요").termIds).toContain("suction");
    expect(correctTranscript("드레싱이랑 소독").termIds).toContain("dressing");
    expect(correctTranscript("브이에스는 정상이에요").text).toContain("V/S는");
  });
});

describe("발음 매칭이 흔한 일반어를 덮어쓰지 않는다 — 실제 전사본에서 나온 사고", () => {
  // 사전 항목 intern 의 별칭 "아이" 가 2음절 발음 매칭(0.925)으로 "아니"·"나이" 를 삼켰다.
  // "아니" 는 한국어에서 가장 흔한 말 중 하나다. 이걸 바꾸면 문장의 뜻이 뒤집힌다.
  it("'아니' 를 '아이'(인턴) 로 바꾸지 않는다", () => {
    const r = correctTranscript("봐준 건 아니라고 하더라고요.");
    expect(r.text).toBe("봐준 건 아니라고 하더라고요.");
    expect(r.edits).toHaveLength(0);
  });

  it("'나이' 도 마찬가지", () => {
    expect(correctTranscript("ccc 나이 그때 줄여서").text).toBe("ccc 나이 그때 줄여서");
  });

  it("'아니 그게 아니라' 가 통째로 뒤집히지 않는다", () => {
    expect(correctTranscript("아니 그게 아니라").text).toBe("아니 그게 아니라");
  });

  it("실제로 '아이' 라고 말한 것은 여전히 인턴으로 주석한다", () => {
    expect(correctTranscript("아이 선생님한테 노티했어요").termIds).toContain("intern");
  });
});

describe("실제 전사본에서 나온 과교정 — 약어 읽기와 조사 붙은 발음 매칭", () => {
  // "알아" 를 알=R, 아=A 로 읽어 RA(room air) 로 바꿨다. "아" 는 A 의 읽기도 R 의 읽기도 아니다.
  it("'알아' 를 약어 RA 로 바꾸지 않는다", () => {
    expect(correctTranscript("왠지 알아.").text).toBe("왠지 알아.");
    expect(correctTranscript("이거 왜 먹는지 알아 내가.").text).toBe("이거 왜 먹는지 알아 내가.");
  });

  it("표준 읽기의 약어는 여전히 되돌린다", () => {
    expect(correctTranscript("에이비지에이 나갔어요").text).toContain("ABGA");
    expect(correctTranscript("알에이 유지 중이에요").text).toContain("RA");
    expect(correctTranscript("이 케이지는 찍어놨습니다.").text).toContain("EKG");
  });

  // "설명은" 의 조사 "은" 이 "천명음" 의 "음" 과 맞아떨어져 0.90 으로 걸렸다.
  // 조사가 붙은 채로 용어와 비슷해진 것은 우연이다 — 조사를 뗀 말이 용어와 가까워야 한다.
  it("조사까지 포함해야 겨우 비슷해지는 말은 고치지 않는다", () => {
    const r = correctTranscript("그리고 피딩은 제가 설명은 했거든요.");
    expect(r.text).toBe("그리고 피딩은 제가 설명은 했거든요.");
  });

  it("조사를 떼도 가까운 오인식은 여전히 고친다", () => {
    expect(correctTranscript("드레씽은 다시 했어요").text).toContain("드레싱은");
  });
});

describe("가려진 이름 토큰 옆의 짧은 말", () => {
  it("'아니 [이름]' 에서 공백 꼬리가 남은 후보를 3음절로 세어 고치지 않는다", () => {
    const s = "아니 [이름] 님이 회피하시고 [이름] 님은 확장할 때 괜찮아요.";
    expect(correctTranscript(s).text).toBe(s);
  });
});

describe("실제 전사본(7,559문장)에서 앱이 잘못 고친 흔한 말들 — 고치지 않아야 한다", () => {
  const keep = [
    "보자가 막 피부를 잘 못 볼 수 있는데", // 피부 → 피버
    "딱히 설정하려고 해 눌러야 돼", // 딱히 → 타키
    "이번에 에스프레소가 아무래도 조금씩 차이가 있어서.", // 이번에 → 입원에
    "다시 한 번 해봐야 막상 해보라고 하면", // 막상 → 낙상
    "오늘 원데이드 라이트 때 받으신 건데", // 라이트 → 나이트
    "혹시 이거 요일도 신경 써야 되나요?", // 되나요? → 데나오?
    "시나리오 샷.", // 시나리오 → 씨알이오
    "뭐 정해진 거 사실은 어때요?", // 정해진 → 전해질
    "뭔가 자전거를 왜 젖었을까", // 자전거를 → 자정거를
    "그래서 오더 받을 때 바로 뒤겼거든요.", // 받을 → 바틀
    "오토 스타트를 온으로 바꾸면 돼요.", // 오토 → 오투
    "한 끼면 해볼게.", // 끼면 → 기면
    "백 아래니까", // 아래니까 → 알에이까
    "1시간 뒤에서 발차를 해달래서 올렸어요.", // 발차를 → 반차를
    "우리 얜 어떻게 해요", // 우리 얜 → 오리엔 (두 어절 발음 매칭)
    "결과 나오면 알려줘", // 결과 나오 → 결과 나옴
  ];
  for (const s of keep) {
    it(`"${s.slice(0, 18)}…" 을 그대로 둔다`, () => {
      expect(correctTranscript(s).text).toBe(s);
    });
  }
});

describe("2026-09-02 세션에서 사용자가 확정한 것 (상표명·처치 용어)", () => {
  it("코스피칭 → 크로스매칭 (수혈 교차시험)", () => {
    const r = correctTranscript("번호 나와서 코스피칭 가져가셨고요.");
    expect(r.text).toContain("크로스매칭");
    expect(r.termIds).toContain("crossmatch");
  });
  it("에프카인 → 에포카인 (EPO 상표명)", () => {
    expect(correctTranscript("에프카인은 하루씩 주잖아요.").text).toContain("에포카인");
  });
  it("포스펜 → 포스페넴 (상표명)", () => {
    expect(correctTranscript("포스펜에 주사제는 만들어야 된다고").text).toContain("포스페넴");
  });
  it("타조 피신(띄어쓰기만 다름)은 주석만, 사조 피신 → 타조피신 (상표명)", () => {
    const spaced = correctTranscript("타조 피신이 지금 원래 하나씩 들어갔는데");
    expect(spaced.termIds).toContain("pip-tazo");
    expect(correctTranscript("사조 피신 들어가는 거").text).toContain("타조피신");
  });
  it("티콜처 없이 리모컬 → 팁 컬처 없이 리무벌 (C-line removal)", () => {
    const r = correctTranscript("체납기 리모컬 해 주라고 그래서 티콜처 없이 리모컬을 했고요.");
    expect(r.text).toContain("팁 컬처");
    expect(r.text).toContain("리무벌");
    expect(r.termIds).toContain("tip-culture");
    expect(r.termIds).toContain("removal");
  });
  it("큐프린은 노르에피네프린 상표명 — 고치지 않고 주석만", () => {
    const r = correctTranscript("큐프린 유지 중에는 90으로 모실 거거든요.");
    expect(r.text).toContain("큐프린");
    expect(r.termIds).toContain("norepinephrine");
  });
  it("다이아이(DI) 는 이 병동의 좌변약 — 고치지 않고 주석만", () => {
    const r = correctTranscript("그러면 다이아이 좀 해주고 올게요.");
    expect(r.text).toContain("다이아이");
    expect(r.termIds).toContain("di-suppository");
  });
  it("오토 스타트는 그대로 (STAT 오인식이 아니다)", () => {
    expect(correctTranscript("오토 스타트를 온으로 바꾸면 돼요.").text).toBe("오토 스타트를 온으로 바꾸면 돼요.");
  });
});

describe("2026-09-03 문맥 교정 세션에서 사용자가 확정한 것", () => {
  const lexicon = defaultLexicon;
  const fix = (s: string) => correctTranscript(s, { lexicon }).text;

  it("뜻이 하나뿐인 오인식은 고친다", () => {
    expect(fix("체온 떨어져서 워먹이 한차례 적용했고요")).toContain("워머");
    // 같은 항목의 다른 표기(온열기)로 고쳐져도 읽는 데는 문제가 없다 — 원문만 아니면 된다.
    expect(fix("어먹이 틀어놨어요")).not.toContain("어먹이");
    expect(fix("하트라인 비아이디로 적혀 있는데")).toContain("판토라인");
  });

  it("흔한 일반어는 뜻이 갈리므로 규칙으로 고치지 않는다", () => {
    // "시기"=식이일 때가 있으나 "시기가 이르다" 도 있다 — 문맥으로만 판단한다.
    expect(fix("아직 시기가 이르다고 하셨어요")).toBe("아직 시기가 이르다고 하셨어요");
    // 이 병원은 항생제 투여를 "행위" 라고 부른다. 오인식이 아니다.
    expect(fix("행위는 타조로 갖고 계시고요")).toBe("행위는 타조로 갖고 계시고요");
    expect(fix("발차 쓰고 오후에 나갔어요")).toBe("발차 쓰고 오후에 나갔어요");
  });
});

describe("2026-09-03 사용자 확정 62건", () => {
  const fix = (s: string) => correctTranscript(s, { lexicon: defaultLexicon }).text;

  it("확정된 오인식을 고친다", () => {
    expect(fix("대노관 한차례 들어갔고요")).toContain("데노간");
    expect(fix("바이팜 걸고 나잘 마스크")).toContain("바이팹");
    expect(fix("레블라이저 끝나면 빼세요")).toContain("네뷸라이저");
    expect(fix("알바민 들어가고 있고요")).toContain("알부민");
    expect(fix("나식스 한 앰플 줬어요")).toContain("라식스");
    expect(fix("신전 도서 다시 찍는 거고")).toContain("심전도");
    expect(fix("감동사가 바뀌었어요")).toContain("간병사");
    expect(fix("오도 받으셨어요")).toContain("오더");
  });

  it("일반어와 겹치는 것은 건드리지 않는다", () => {
    // 사용자가 "추석→석션", "음료수→옴니옥스" 를 확정했지만 둘 다 일상어라
    // 규칙으로 만들지 않았다. 문맥으로만 판단한다.
    for (const s of [
      "추석 연휴에 근무 바꿨어요",
      "음료수 드시고 싶다고",
      "티켓 예매했어요",
    ]) {
      expect(fix(s)).toBe(s);
    }
  });

  it("간병사와 요양보호사는 다른 직역이라 섞지 않는다", () => {
    expect(fix("감동사가 바뀌었어요")).not.toContain("요양보호사");
  });
});

describe("LLM 에 보내는 규칙표", () => {
  it("사전의 오인식 표기를 담는다 — 용어집만으로는 LLM 이 모른다", () => {
    const rules = buildCorrectionRulesForLLM(defaultLexicon);
    expect(rules).toContain("데노간 ← ");
    expect(rules).toContain("대노관");
    expect(rules).toContain("간병사 ← ");
  });

  it("문맥으로만 판단할 말들의 이유를 함께 보낸다", () => {
    const rules = buildCorrectionRulesForLLM(defaultLexicon);
    // 규칙으로 못 만든 것은 LLM 이 문맥으로 판단해야 하므로 기준을 준다.
    expect(rules).toContain("행위");
    expect(rules).toContain("추석");
    // 그 말들이 대응표 쪽에 규칙으로 들어가 있으면 안 된다.
    expect(rules).not.toContain("← 추석");
    expect(rules).not.toContain("← 음료수");
  });
});

describe("휘스퍼 전용 교정", () => {
  const lex = defaultLexicon;
  const fix = (s: string, engine?: "whisper" | "other") =>
    correctTranscript(s, { lexicon: lex, asrEngine: engine }).text;

  it("휘스퍼 전사본이면 오인식을 고친다 (기본값)", () => {
    expect(fix("대노관 한차례 들어갔고요")).toContain("데노간");
    expect(fix("대노관 한차례 들어갔고요", "whisper")).toContain("데노간");
  });

  it("다른 엔진이면 오인식 목록을 쓰지 않는다", () => {
    // 제미나이는 다르게 틀린다. 휘스퍼의 오류 습관을 들이대면 엉뚱한 말을 바꾼다.
    expect(fix("대노관 한차례 들어갔고요", "other")).toBe("대노관 한차례 들어갔고요");
    expect(fix("감동사가 바뀌었어요", "other")).toBe("감동사가 바뀌었어요");
  });

  it("엔진과 무관한 교정은 그대로 돈다", () => {
    // 사전 표기·별칭은 사람이 실제로 그렇게 말하는 것이라 엔진과 상관없다.
    expect(fix("브이에스 체크했어요", "other")).not.toBe("브이에스 체크했어요");
  });
});
