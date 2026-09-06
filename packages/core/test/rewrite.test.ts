import { describe, it, expect } from "vitest";
import { rewriteOnce } from "../src/index.js";

describe("확정된 교정 반영", () => {
  it("여러 번 나와도 다 고친다", () => {
    const r = rewriteOnce("포리 확인했어요 포리도", [{ from: "포리", to: "폴리" }]);
    expect(r.text).toBe("폴리 확인했어요 폴리도");
    expect(r.hits.map((h) => h.at)).toEqual([0, 9]);
  });

  it("앞 교정의 결과가 뒤 교정에 다시 걸리지 않는다", () => {
    // 낱말마다 따로 훑던 때는 "포리" 가 "유치도뇨관" 이 됐다. 아무도 안 시켰다.
    const r = rewriteOnce("포리 봤어요", [
      { from: "포리", to: "폴리" },
      { from: "폴리", to: "유치도뇨관" },
    ]);
    expect(r.text).toBe("폴리 봤어요");
  });

  it("바꿀 말이 결과 안에 들어 있어도 한 번만 고친다", () => {
    // "폴리 카테터 카테터 카테터…" 로 늘어나던 자리.
    const r = rewriteOnce("폴리 꽂았어요", [{ from: "폴리", to: "폴리 카테터" }]);
    expect(r.text).toBe("폴리 카테터 꽂았어요");
    expect(rewriteOnce(r.text, [{ from: "폴리", to: "폴리 카테터" }]).text).toBe(
      "폴리 카테터 카테터 꽂았어요",
    );
    // ↑ 두 번 부르면 늘어난다. 그래서 부르는 쪽(앱)이 이미 넣은 것을 건너뛴다.
  });

  it("같은 자리에서는 긴 쪽을 고른다", () => {
    const r = rewriteOnce("폴리 카테터 확인", [
      { from: "폴리", to: "foley" },
      { from: "폴리 카테터", to: "유치도뇨관" },
    ]);
    expect(r.text).toBe("유치도뇨관 확인");
  });

  it("고칠 것이 없으면 원문 그대로다", () => {
    const r = rewriteOnce("폴리 확인", [{ from: "포리", to: "폴리" }]);
    expect(r.text).toBe("폴리 확인");
    expect(r.hits).toEqual([]);
  });

  it("빈 값이나 같은 값은 버린다", () => {
    const r = rewriteOnce("가 있어요", [
      { from: "", to: "x" },
      { from: "가", to: "가" },
    ]);
    expect(r.text).toBe("가 있어요");
  });
});
