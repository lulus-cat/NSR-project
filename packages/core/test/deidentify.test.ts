import { describe, it, expect } from "vitest";
import {
  checkBeforeExport,
  deidentify,
  describeRedactions,
} from "../src/transcription/index.js";

describe("개인정보 가리기", () => {
  it("이름·등록번호·전화번호를 가린다", () => {
    const r = deidentify("김영희님 등록번호 12345678, 연락처 010-1234-5678");
    expect(r.text).toContain("[이름]님");
    expect(r.text).toContain("[등록번호]");
    expect(r.text).toContain("[전화번호]");
    expect(r.text).not.toContain("김영희");
    expect(r.text).not.toContain("12345678");
  });

  it("호칭은 남기고 이름만 가린다", () => {
    // "[이름]" 만 남으면 누구를 부른 말인지 문장이 무너진다.
    expect(deidentify("박철수 환자 상태 어때요").text).toBe("[이름] 환자 상태 어때요");
    expect(deidentify("이수진 선생님께 노티했어요").text).toContain("[이름] 선생님");
  });

  it("주민등록번호를 등록번호보다 먼저 잡는다", () => {
    const r = deidentify("900101-2345678");
    expect(r.text).toBe("[주민번호]");
    expect(r.byKind.rrn).toBe(1);
    expect(r.byKind.mrn).toBeUndefined();
  });

  it("뒷자리가 가려진 주민번호도 잡는다", () => {
    expect(deidentify("900101-2******").text).toBe("[주민번호]");
  });

  it("생년월일을 가린다", () => {
    expect(deidentify("1952년 3월 5일생").text).toContain("[생년월일]");
    expect(deidentify("1952-03-05 입원").text).toContain("[생년월일]");
  });

  it("지역번호 전화도 잡는다", () => {
    expect(deidentify("02-1234-5678").text).toBe("[전화번호]");
    expect(deidentify("031-123-4567로 연락").text).toContain("[전화번호]");
  });

  it("임상 수치는 건드리지 않는다", () => {
    // 여기서 숫자를 가리면 전사본이 쓸모없어진다.
    const text = "혈압 120/80, 맥박 72, 체온 36.5도, 인슐린 10단위";
    expect(deidentify(text).text).toBe(text);
  });

  it("호칭 앞의 일반명사는 이름으로 보지 않는다", () => {
    expect(deidentify("담당 선생님께 물어보세요").text).toContain("담당 선생님");
    expect(deidentify("고위험 환자 확인").text).toContain("고위험 환자");
    expect(deidentify("치매 환자분이에요").text).toContain("치매 환자분");
  });

  it("병실·침상은 기본으로 가리지 않는다", () => {
    // 임상적으로 필요한 경우가 많아 기본은 꺼둔다.
    expect(deidentify("302호실 3번 침상").text).toContain("302호실");
    expect(deidentify("302호실 3번 침상", { disable: [] }).text).toContain("[위치]");
  });

  it("종류를 끌 수 있다", () => {
    const r = deidentify("김영희님 010-1234-5678", { disable: ["phone", "location"] });
    expect(r.text).toContain("[이름]");
    expect(r.text).toContain("010-1234-5678");
  });

  it("사용자가 등록한 말도 가린다", () => {
    const r = deidentify("영희야 이것 좀 봐줘", { extraTerms: ["영희"] });
    expect(r.text).toContain("[이름]");
  });

  it("종류별로 센다", () => {
    const r = deidentify("김영희님과 박철수님, 010-1234-5678");
    expect(r.byKind.name).toBe(2);
    expect(r.byKind.phone).toBe(1);
    expect(r.redactedCount).toBe(3);
  });

  it("무엇을 가렸는지 사람 말로 알려준다", () => {
    const r = deidentify("김영희님 010-1234-5678");
    expect(describeRedactions(r)).toContain("이름 1건");
    expect(describeRedactions(deidentify("아무것도 없음"))).toContain("찾지 못했");
  });

  it("원문을 바꾸지 않는다", () => {
    const original = "김영희님 확인";
    deidentify(original);
    expect(original).toBe("김영희님 확인");
  });
});

describe("내보내기 전 점검", () => {
  it("가리지 못한 긴 숫자가 남으면 알려준다", () => {
    const r = deidentify("확인번호 1234 그리고 5678");
    const w = checkBeforeExport(r);
    expect(w.some((x) => x.reason === "many-digits")).toBe(true);
  });

  it("하나도 못 가렸으면 의심하라고 한다", () => {
    const w = checkBeforeExport(deidentify("특이사항 없음"));
    expect(w.some((x) => x.reason === "nothing-redacted")).toBe(true);
  });

  it("오디오를 함께 보내면 가릴 수 없다고 경고한다", () => {
    const w = checkBeforeExport(deidentify("김영희님"), { includesAudio: true });
    const audio = w.find((x) => x.reason === "audio-not-maskable");
    expect(audio?.message).toContain("목소리");
  });
});
