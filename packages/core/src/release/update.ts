/**
 * 새 판이 나왔는지 본다 — GitHub Releases 를 그대로 기준으로 쓴다.
 *
 * 조용히 알아서 깔리게는 못 만든다
 * -----------------------------
 * 안드로이드는 설치할 때 반드시 사람이 확인 화면을 눌러야 한다. 시스템 앱이나
 * 기기 관리자면 예외인데, 옆에서 받아 까는 앱은 거기 해당하지 않는다.
 * 그러니 앱이 할 수 있는 것은 여기까지다 —
 * **새 판이 나온 것을 알아채고, 받는 곳까지 한 번에 데려다주는 것.**
 * 그 뒤 "설치" 를 누르는 것은 사람 몫이다.
 *
 * 여기는 주소를 만들고 응답을 읽는 일만 한다
 * ---------------------------------------
 * 실제로 부르는 것은 앱 쪽이다. 그래야 이 판단 로직을 테스트할 수 있다 —
 * 네트워크를 끼워 넣으면 "1.2.10 이 1.2.9 보다 큰가" 같은 것을 검사할 수 없다.
 */

/**
 * 판 번호를 숫자 배열로. v1.2.10 → [1, 2, 10]
 *
 * 꼬리표(-alpha.2 등)는 **첫 '-' 에서 통째로 잘라 버린다.**
 * 안 자르면 "0.1.3-alpha.2" 가 [0,1,3,2] 로 읽혀 그냥 "0.1.3" 보다 큰 판이 된다.
 * 알파가 정식판보다 새 판으로 잡히면 업데이트 알림이 거꾸로 뜬다.
 *
 * 잘라내는 쪽을 고른 결과, 같은 0.1.3 의 알파와 정식판은 **같은 판으로** 읽힌다.
 * 알파끼리의 순서는 못 가리지만, 이 앱은 태그를 v0.1.5 처럼 숫자로만 붙이고
 * 알파 여부는 릴리스의 prerelease 표시로 따로 나르므로 문제가 되지 않는다.
 */
export function versionParts(v: string): number[] {
  return String(v ?? "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(/[.+]/)
    .map((x) => parseInt(x, 10))
    .filter((n) => !Number.isNaN(n));
}

/**
 * 판 번호 비교. a 가 크면 1, 같으면 0, 작으면 -1.
 *
 * 글자로 견주면 안 된다. `"1.2.10" < "1.2.9"` 가 되어 새 판이 나와도 모른다.
 *
 * '-' 를 구분자로 쓰지 않는 것도 중요하다. 잘못 붙은 태그 v1.2.-15 가
 * [1,2,15] 로 읽혀 1.2.12 보다 새 판이 되어 버린다. '-' 뒤는 parseInt 가
 * 알아서 버리므로 **v0.1.3-alpha 는 [0,1,3]** 이 되고 v1.2.-15 는 [1,2,-15] —
 * 있는 그대로 낮은 판으로 읽힌다.
 */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

/** 저장소의 최신 릴리스 주소. 토큰이 필요 없다 (공개 저장소). */
export function latestReleaseUrl(repo: string): string {
  const r = String(repo ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) return "";
  return `https://api.github.com/repos/${r}/releases/latest`;
}

/**
 * 저장소의 릴리스 **목록** 주소.
 *
 * `releases/latest` 는 쓰지 않는다 — GitHub 은 거기서 **프리릴리스를 뺀** 최신만
 * 준다. 이 앱은 전부 알파(prerelease)로 올리므로 latest 가 늘 404 였고,
 * 그래서 새 판이 나와도 앱이 "아직 올라온 판이 없습니다" 만 보여줬다.
 */
export function releaseListUrl(repo: string): string {
  const base = latestReleaseUrl(repo);
  return base ? base.replace(/\/latest$/, "?per_page=10") : "";
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  notes: string;
  published: string;
  apkUrl: string;
  apkSizeMb: number;
  pageUrl: string;
  prerelease: boolean;
}

/**
 * 응답에서 쓸 것만 꺼낸다.
 *
 * APK 를 못 찾으면 릴리스 쪽(html_url)이라도 준다. 소스만 올라간 릴리스에서
 * "받기" 가 아무 데도 안 가면 고장으로 보인다.
 */
export function parseRelease(body: unknown): ReleaseInfo | null {
  let d = body;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  if (!r.tag_name) return null;

  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
  const apk = assets.find(
    (a) =>
      a &&
      typeof a.name === "string" &&
      /\.apk$/i.test(a.name) &&
      typeof a.browser_download_url === "string",
  );

  const tag = String(r.tag_name);
  return {
    tag,
    version: tag.replace(/^v/i, ""),
    name: String(r.name ?? tag),
    notes: String(r.body ?? ""),
    published: String(r.published_at ?? ""),
    apkUrl: apk ? String(apk.browser_download_url) : "",
    apkSizeMb: apk ? Math.round((Number(apk.size) || 0) / (1024 * 1024) * 10) / 10 : 0,
    pageUrl: String(r.html_url ?? ""),
    prerelease: r.prerelease === true,
  };
}

/**
 * 목록에서 알릴 판을 고른다.
 *
 * 드래프트는 버리고, **프리릴리스는 포함한다** — 이 앱의 배포가 전부 알파다.
 * 목록 순서를 믿지 않고 판 번호가 가장 높은 것을 고른다.
 */
export function pickLatestRelease(body: unknown): ReleaseInfo | null {
  let d = body;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(d)) return parseRelease(d);
  let best: ReleaseInfo | null = null;
  for (const item of d) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).draft === true) {
      continue;
    }
    const r = parseRelease(item);
    if (r && (!best || compareVersions(r.version, best.version) > 0)) best = r;
  }
  return best;
}

/**
 * 지금 볼 때가 되었는가.
 *
 * 켤 때마다 물어보지 않는다. 토큰 없이 부르면 한 시간에 60번까지라, 자주 부르면
 * 정작 필요할 때 막힌다. 릴리스가 하루에 몇 번씩 나오지도 않는다.
 */
export function isCheckDue(lastAt: number, now: number, hours = 6): boolean {
  const gap = hours * 3600 * 1000;
  const t = Number(lastAt) || 0;
  if (!t) return true;
  // 폰 시계를 뒤로 돌려 놓으면 lastAt 이 미래가 된다. 그때도 막히지 않게 한다.
  if (now < t) return true;
  return now - t >= gap;
}

export interface UpdateDecision {
  show: boolean;
  version?: string;
  reason: "new" | "current" | "skipped" | "unknown" | "none";
  message: string;
}

/** 알릴 것이 있는가. */
export function decideUpdate(input: {
  current?: string;
  latest?: ReleaseInfo | null;
  skipped?: string;
}): UpdateDecision {
  const latest = input.latest;
  if (!latest?.version) {
    return { show: false, reason: "none", message: "배포 버전을 찾지 못했습니다." };
  }
  // 현재 판을 모르면(개발 중 실행 등) 알림을 띄우지 않는다.
  // 늘 "새 판이다" 가 되어 버려 알림이 무의미해진다.
  if (!input.current) {
    return {
      show: false,
      version: latest.version,
      reason: "unknown",
      message: `최신 버전은 ${latest.version}입니다. 현재 앱의 버전을 알 수 없습니다.`,
    };
  }
  if (compareVersions(latest.version, input.current) <= 0) {
    return {
      show: false,
      version: latest.version,
      reason: "current",
      message: `최신 버전입니다 (${latest.version}).`,
    };
  }
  if (input.skipped && compareVersions(latest.version, input.skipped) <= 0) {
    return {
      show: false,
      version: latest.version,
      reason: "skipped",
      message: `${latest.version} 버전을 건너뛰도록 설정했습니다.`,
    };
  }
  return {
    show: true,
    version: latest.version,
    reason: "new",
    message: `새 버전 ${latest.version}이 있습니다 (현재 버전 ${input.current}).`,
  };
}

/**
 * 릴리스 본문에서 바뀐 것만 몇 줄 뽑는다.
 * 접힌 부분(자세한 설명)과 인용구·표·링크는 버린다.
 */
export function releaseHighlights(notes: string, max = 5): string[] {
  return String(notes ?? "")
    .replace(/<details[\s\S]*?<\/details>/gi, "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("#") &&
        !l.startsWith(">") &&
        !l.startsWith("|") &&
        !/^https?:\/\//.test(l) &&
        !/^-{3,}$/.test(l),
    )
    .slice(0, max);
}
