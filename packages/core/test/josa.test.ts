import { describe, it, expect } from "vitest";
import { josa, withJosa } from "../src/hangul/josa.js";

describe("조사 고르기", () => {
  it("받침 있으면 을/은/이/과", () => {
    expect(josa("석션", "을")).toBe("을");
    expect(josa("석션", "은")).toBe("은");
    expect(josa("석션", "이")).toBe("이");
    expect(josa("석션", "와")).toBe("과");
  });

  it("받침 없으면 를/는/가/와", () => {
    expect(josa("폴리", "을")).toBe("를");
    expect(josa("폴리", "은")).toBe("는");
    expect(josa("폴리", "가")).toBe("가");
    expect(josa("폴리", "과")).toBe("와");
  });

  it("어느 쪽으로 적어도 결과는 같다", () => {
    expect(josa("석션", "를")).toBe(josa("석션", "을"));
    expect(josa("폴리", "은")).toBe(josa("폴리", "는"));
  });

  it("ㄹ 받침은 '으로'가 아니라 '로'", () => {
    expect(josa("폴", "으로")).toBe("로");
    expect(josa("병동", "으로")).toBe("으로");
    expect(josa("나이트", "으로")).toBe("로");
  });

  it("숫자는 읽는 소리로 판단한다", () => {
    // 병동 대화에 "302호를", "5번을" 같은 말이 흔하다.
    expect(josa("3", "을")).toBe("을"); // 삼
    expect(josa("2", "을")).toBe("를"); // 이
    expect(josa("5", "은")).toBe("는"); // 오
    expect(josa("7", "은")).toBe("은"); // 칠
  });

  it("영문 약어는 못 고른다 — 괄호형으로 둔다", () => {
    // "ABGA"를 뭐라 읽는지에 따라 갈린다. 지어내는 것보다 정직하다.
    expect(josa("ABGA", "을")).toBe("을(를)");
    expect(josa("DNR", "으로")).toBe("(으)로");
  });

  it("모르는 조사는 그대로 둔다", () => {
    expect(josa("석션", "에서")).toBe("에서");
  });

  it("withJosa는 붙여서 돌려준다", () => {
    expect(withJosa("폴리", "을")).toBe("폴리를");
    expect(withJosa("석션", "을")).toBe("석션을");
  });
});
