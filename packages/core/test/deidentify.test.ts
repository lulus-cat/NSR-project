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

  it("조사로 끝나는 말은 이름으로 보지 않는다", () => {
    // "환자"는 호칭이기도 하고("박철수 환자") 그냥 명사이기도 하다("의사에게 환자").
    // 이름은 조사로 끝나지 않는다는 것이 둘을 가르는 유일하게 싼 신호다.
    expect(deidentify("의사에게 환자 상태 변화를 알렸어요").text).toBe(
      "의사에게 환자 상태 변화를 알렸어요",
    );
    expect(deidentify("병동에서 보호자 만났어요").text).toBe("병동에서 보호자 만났어요");
    expect(deidentify("간호사한테 환자분 얘기 들었어요").text).toBe(
      "간호사한테 환자분 얘기 들었어요",
    );
    // 그래도 진짜 이름은 계속 잡혀야 한다.
    expect(deidentify("김영희 환자분 드레싱했어요").text).toContain("[이름] 환자분");
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

describe("병실 번호 — '호실' 말고 '호' 만 붙는 말투", () => {
  // 병동에서는 "302호실"보다 "302호"라고 부른다. 실제 티로 노트에서
  // "302호 확인" 이 안 가려진 채로 나갔다.
  it("'302호' 를 가린다", () => {
    const r = deidentify("302호 확인했어요.", { disable: [] });
    expect(r.text).not.toContain("302");
    expect(r.redactions[0].kind).toBe("location");
  });

  it("조사가 붙어도 가린다 — '302호예요'", () => {
    // (?![가-힣]) 로 막았더니 '예요'까지 걸려서 안 가려졌다. 실제 말투가 이쪽이다.
    for (const line of ["302호예요", "302호에 계세요", "302호로 옮겼어요"]) {
      expect(deidentify(line, { disable: [] }).text).not.toContain("302");
    }
  });

  it("'302호실' 도 그대로 가린다", () => {
    expect(deidentify("302호실 확인", { disable: [] }).text).not.toContain("302");
  });

  it("호수가 아닌 '호' 는 안 건드린다", () => {
    for (const line of ["2호선 타고 왔어요", "1호기 점검", "3호봉이에요"]) {
      expect(deidentify(line, { disable: [] }).text).toBe(line);
    }
  });

  it("기본값(location 끔)에서는 그대로 둔다", () => {
    expect(deidentify("302호 확인").text).toBe("302호 확인");
  });
});

/**
 * 이름을 놓친 자리들 (외부 코드 리뷰가 실제 입력으로 잡아 준 것).
 *
 * 공통점이 둘이다.
 *   - 이름과 호칭 사이에 **직함**이 끼면 이름을 못 봤다. 그리고 직함을 이름으로
 *     알고 가려서, "이름 1건 가렸습니다"라는 확인 문구까지 거짓이 됐다.
 *   - 병동에서 실제로 쓰는 호칭(간호사·쌤·교수·선생)이 목록에 없었다.
 *
 * 동료 이름은 태움 기록의 핵심이다. 여기서 새면 그 기록이 곧 명단이 된다.
 */
describe("이름 — 직함이 끼거나 호칭이 다를 때", () => {
  const 가려짐 = (원문: string, 이름: string) => {
    const r = deidentify(원문, { disable: [] });
    expect(r.text).not.toContain(이름);
    expect(r.text).toContain("[이름]");
  };

  it("이름과 선생님 사이에 직함이 들어가도 이름을 가린다", () => {
    가려짐("김미영 프리셉터 선생님이 알려 주셨어요", "김미영");
    가려짐("이수진 책임 선생님한테 물어보세요", "이수진");
    가려짐("박영수 수간호사 선생님이 화내셨어요", "박영수");
  });

  it("병동에서 쓰는 다른 호칭도 잡는다", () => {
    가려짐("8병동 이수진 간호사한테 인계했어요", "이수진");
    가려짐("김영희 쌤이 오늘 나이트예요", "김영희");
    가려짐("정형외과 박민수 선생 콜 했어요", "박민수");
    가려짐("신경과 김도현 교수 협진 났어요", "김도현");
  });

  it("직함·병명을 이름으로 잘못 가리지 않는다", () => {
    // 예전에는 '폐렴'을 이름으로 가려 놓고 "이름을 가렸다"고 적었다.
    const r = deidentify("302호 폐렴 환자 산소 3리터 유지 중이에요", { disable: [] });
    expect(r.text).toContain("폐렴");
    expect(r.redactions.some((x) => x.kind === "name")).toBe(false);
  });

  it("성만 있고 직함이 붙어도 가린다", () => {
    가려짐("최 교수님 회진 도실 때 같이 가요", "최 교수님");
  });
});
