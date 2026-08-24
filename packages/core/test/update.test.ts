import { describe, it, expect } from "vitest";
import {
  compareVersions,
  decideUpdate,
  isCheckDue,
  latestReleaseUrl,
  parseRelease,
  pickLatestRelease,
  releaseListUrl,
  releaseHighlights,
  versionParts,
} from "../src/release/update.js";

describe("판 번호 비교", () => {
  it("숫자로 견준다", () => {
    // 글자로 견주면 "1.2.10" < "1.2.9" 가 되어 새 판이 나와도 모른다.
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.9", "1.2.10")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("v 접두사가 있어도 없어도 같다", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("자리 수가 달라도 된다", () => {
    expect(compareVersions("1.3", "1.2.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("알파 꼬리표는 무시한다", () => {
    expect(versionParts("0.1.3-alpha.2")).toEqual([0, 1, 3]);
    expect(compareVersions("0.1.3-alpha", "0.1.3")).toBe(0);
  });

  it("알파가 정식판보다 새 판으로 잡히지 않는다", () => {
    // 안 자르면 "0.1.3-alpha.2"가 [0,1,3,2]로 읽혀 "0.1.3"보다 커진다.
    // 그러면 업데이트 알림이 거꾸로 뜬다.
    expect(compareVersions("0.1.3-alpha.2", "0.1.3")).toBe(0);
    expect(compareVersions("0.1.3-alpha.2", "0.1.4")).toBe(-1);
  });

  it("음수 판 번호를 큰 수로 읽지 않는다", () => {
    // 잘못 붙은 태그 v1.2.-15 를 [1,2,15]로 읽으면 1.2.12보다 새 판이 되어 버린다.
    expect(compareVersions("1.2.-15", "1.2.12")).toBe(-1);
  });
});

describe("릴리스 주소", () => {
  it("owner/repo 로 만든다", () => {
    expect(latestReleaseUrl("lulus-cat/NSR-project")).toBe(
      "https://api.github.com/repos/lulus-cat/NSR-project/releases/latest",
    );
  });

  it("전체 주소를 넣어도 된다", () => {
    expect(latestReleaseUrl("https://github.com/lulus-cat/NSR-project.git")).toContain(
      "/repos/lulus-cat/NSR-project/",
    );
  });

  it("이상한 값이면 빈 문자열", () => {
    expect(latestReleaseUrl("")).toBe("");
    expect(latestReleaseUrl("그냥글자")).toBe("");
  });
});

describe("응답 읽기", () => {
  const body = {
    tag_name: "v0.1.5",
    name: "근무기록 0.1.5 (알파)",
    body: "## 이번 판에서 바뀐 것\n\n- 문장 단위로 나눔\n- 화자 지정 고침\n",
    published_at: "2026-08-24T00:00:00Z",
    html_url: "https://github.com/x/y/releases/tag/v0.1.5",
    prerelease: true,
    assets: [
      { name: "source.zip", size: 100, browser_download_url: "https://x/source.zip" },
      { name: "nsr-0.1.5-alpha.apk", size: 52428800, browser_download_url: "https://x/a.apk" },
    ],
  };

  it("APK 를 골라낸다", () => {
    const r = parseRelease(body);
    expect(r?.apkUrl).toBe("https://x/a.apk");
    expect(r?.apkSizeMb).toBe(50);
  });

  it("판 번호에서 v 를 뗀다", () => {
    expect(parseRelease(body)?.version).toBe("0.1.5");
  });

  it("알파 표시를 읽는다", () => {
    expect(parseRelease(body)?.prerelease).toBe(true);
  });

  it("APK 가 없으면 릴리스 쪽 주소라도 준다", () => {
    // "받기"가 아무 데도 안 가면 고장으로 보인다.
    const r = parseRelease({ ...body, assets: [] });
    expect(r?.apkUrl).toBe("");
    expect(r?.pageUrl).toContain("releases/tag");
  });

  it("문자열로 줘도 읽는다", () => {
    expect(parseRelease(JSON.stringify(body))?.version).toBe("0.1.5");
  });

  it("이상한 응답이면 null", () => {
    expect(parseRelease("{망가진 json")).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({})).toBeNull();
  });
});

describe("pickLatestRelease — 알파만 올리는 저장소", () => {
  const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    prerelease: true,
    assets: [],
    ...extra,
  });

  it("프리릴리스뿐이어도 골라낸다 — latest API 404 버그의 회귀 테스트", () => {
    expect(pickLatestRelease([rel("v0.1.5")])?.version).toBe("0.1.5");
  });

  it("목록 순서가 아니라 판 번호가 높은 것을 고른다", () => {
    expect(pickLatestRelease([rel("v0.1.9"), rel("v0.1.10")])?.version).toBe("0.1.10");
  });

  it("드래프트는 건너뛴다", () => {
    expect(pickLatestRelease([rel("v0.2.0", { draft: true }), rel("v0.1.5")])?.version).toBe(
      "0.1.5",
    );
  });

  it("빈 목록이나 쓰레기는 null", () => {
    expect(pickLatestRelease([])).toBeNull();
    expect(pickLatestRelease("{망가진")).toBeNull();
  });

  it("목록 주소는 latest 가 아니다", () => {
    expect(releaseListUrl("lulus-cat/NSR-project")).toBe(
      "https://api.github.com/repos/lulus-cat/NSR-project/releases?per_page=10",
    );
    expect(releaseListUrl("")).toBe("");
  });
});

describe("확인할 때가 되었는가", () => {
  const HOUR = 3600 * 1000;

  it("한 번도 안 봤으면 본다", () => {
    expect(isCheckDue(0, 1000)).toBe(true);
  });

  it("여섯 시간이 안 지났으면 안 본다", () => {
    // 토큰 없이 부르면 한 시간에 60번까지다. 자주 부르면 정작 필요할 때 막힌다.
    expect(isCheckDue(1000, 1000 + HOUR)).toBe(false);
  });

  it("여섯 시간이 지나면 본다", () => {
    expect(isCheckDue(1000, 1000 + 6 * HOUR)).toBe(true);
  });

  it("폰 시계를 뒤로 돌려도 막히지 않는다", () => {
    expect(isCheckDue(10 * HOUR, 1000)).toBe(true);
  });
});

describe("알릴지 정하기", () => {
  const latest = parseRelease({ tag_name: "v0.2.0", assets: [] })!;

  it("새 판이면 알린다", () => {
    const d = decideUpdate({ current: "0.1.5", latest });
    expect(d.show).toBe(true);
    expect(d.reason).toBe("new");
    expect(d.message).toContain("0.2.0");
  });

  it("같거나 낮으면 안 알린다", () => {
    expect(decideUpdate({ current: "0.2.0", latest }).show).toBe(false);
    expect(decideUpdate({ current: "0.3.0", latest }).reason).toBe("current");
  });

  it("건너뛰기로 해 둔 판은 안 알린다", () => {
    const d = decideUpdate({ current: "0.1.5", latest, skipped: "0.2.0" });
    expect(d.show).toBe(false);
    expect(d.reason).toBe("skipped");
  });

  it("건너뛴 판보다 더 새 판이면 다시 알린다", () => {
    const newer = parseRelease({ tag_name: "v0.3.0", assets: [] })!;
    expect(decideUpdate({ current: "0.1.5", latest: newer, skipped: "0.2.0" }).show).toBe(true);
  });

  it("지금 판을 모르면 안 알린다", () => {
    // 늘 "새 판이다"가 되어 버려 알림이 무의미해진다.
    const d = decideUpdate({ current: undefined, latest });
    expect(d.show).toBe(false);
    expect(d.reason).toBe("unknown");
  });

  it("릴리스를 못 찾으면 안 알린다", () => {
    expect(decideUpdate({ current: "0.1.0", latest: null }).reason).toBe("none");
  });
});

describe("바뀐 것 뽑기", () => {
  it("목록 줄만 뽑는다", () => {
    const notes = "## 이번 판\n\n- 문장 단위로 나눔\n- 화자 지정 고침\n";
    expect(releaseHighlights(notes)).toEqual(["문장 단위로 나눔", "화자 지정 고침"]);
  });

  it("접힌 부분은 버린다", () => {
    const notes = "- 앞줄\n<details><summary>자세히</summary>\n- 안쪽\n</details>";
    expect(releaseHighlights(notes)).toEqual(["앞줄"]);
  });

  it("인용구와 링크는 버린다", () => {
    const notes = "> 알파 판입니다\n- 진짜 변경\nhttps://example.com";
    expect(releaseHighlights(notes)).toEqual(["진짜 변경"]);
  });

  it("개수를 제한한다", () => {
    const notes = Array.from({ length: 20 }, (_, i) => `- 변경 ${i}`).join("\n");
    expect(releaseHighlights(notes, 3).length).toBe(3);
  });

  it("빈 본문이면 빈 목록", () => {
    expect(releaseHighlights("")).toEqual([]);
  });
});
