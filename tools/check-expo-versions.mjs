/**
 * 설치된 판이 Expo SDK 가 기대하는 판과 같은지 본다.
 *
 * 왜 필요한가
 * ----------
 * 이 프로젝트의 APK 빌드는 판 불일치로 네 번 깨졌다. 매번 모습이 달랐다.
 *
 *   1. gradle 래퍼가 낮다        (react-native 판이 달라서)
 *   2. Kotlin 메타데이터가 안 맞다 (1번을 잘못 고쳐서)
 *   3. npm ci 가 peer 충돌       (react-dom 이 안 묶여 있어서)
 *   4. C++ 에 없는 함수를 부른다   (react-native-worklets 판이 달라서)
 *
 * 전부 같은 뿌리다. package.json 의 `^` 범위는 **아무도 안 묶어 두면 최신으로
 * 흘러간다.** Expo 는 자기가 시험한 조합이 있는데, 그 조합을 벗어나면
 * 네이티브 빌드가 한참 뒤에 엉뚱한 모습으로 깨진다.
 *
 * 4번은 C++ 컴파일까지 16분을 태우고 나서야 나왔다. 그 16분을 몇 초로 줄인다.
 *
 * 판단 기준
 * --------
 * `expo/bundledNativeModules.json` 이 Expo 가 "이 판으로 시험했다" 고 적어 둔 목록이다.
 * 설치된 것이 그 범위를 벗어나면 알린다.
 *
 * 사용: node tools/check-expo-versions.mjs [앱 폴더]
 */

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? "apps/mobile");
const require = createRequire(join(appDir, "package.json"));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

let bundled;
try {
  bundled = readJson(require.resolve("expo/bundledNativeModules.json"));
} catch {
  console.error("expo/bundledNativeModules.json 을 못 찾았습니다. 설치부터 하세요.");
  process.exit(1);
}

/** 설치된 판. 없으면 null. */
function installed(name) {
  const p = join(appDir, "node_modules", name, "package.json");
  return existsSync(p) ? readJson(p).version : null;
}

/**
 * 범위를 만족하는지 본다.
 *
 * semver 를 따로 안 들인다. 여기서 필요한 것은 "^x.y.z" 하나뿐이고,
 * 그 판정은 직접 쓰는 편이 의존성을 하나 더 다는 것보다 낫다.
 *
 * ^0.x.y 는 0.x 안에서만 올라간다는 뜻이다 (0 은 마이너가 메이저처럼 취급된다).
 * 이 규칙을 놓치면 worklets 0.10 → 0.12 를 통과시켜 버린다. 이번에 깨진 자리다.
 */
function satisfiesCaret(version, range) {
  const spec = range.replace(/^\^/, "");
  const v = version.split(".").map(Number);
  const s = spec.split(".").map(Number);
  if (v.some(Number.isNaN) || s.some(Number.isNaN)) return null; // 판단 불가

  if (v[0] !== s[0]) return false;
  if (s[0] === 0) {
    // ^0.10.1 → 0.10.x 만 허용
    if (v[1] !== s[1]) return false;
    return v[2] >= s[2];
  }
  if (v[1] !== s[1]) return v[1] > s[1];
  return v[2] >= s[2];
}

const drift = [];
const unknown = [];

for (const [name, expected] of Object.entries(bundled)) {
  const have = installed(name);
  if (!have) continue; // 안 쓰는 것은 볼 필요 없다

  // bundledNativeModules 는 대개 "~x.y.z" 나 "x.y.z" 또는 "^x.y.z" 로 적혀 있다.
  const spec = String(expected).trim();
  if (spec.startsWith("^")) {
    const ok = satisfiesCaret(have, spec);
    if (ok === false) drift.push({ name, have, expected: spec });
    else if (ok === null) unknown.push({ name, have, expected: spec });
  } else {
    const exact = spec.replace(/^[~=]/, "");
    // ~x.y.z 는 x.y 안에서만. 정확한 판은 그대로 비교.
    if (spec.startsWith("~")) {
      const v = have.split(".");
      const s = exact.split(".");
      if (v[0] !== s[0] || v[1] !== s[1]) drift.push({ name, have, expected: spec });
    } else if (have !== exact) {
      drift.push({ name, have, expected: spec });
    }
  }
}

if (unknown.length > 0) {
  console.log("판단하지 못한 것 (직접 확인하세요):");
  for (const u of unknown) console.log(`  ${u.name}: 설치됨 ${u.have} / 기대 ${u.expected}`);
  console.log();
}

if (drift.length === 0) {
  console.log("Expo SDK 가 기대하는 판과 모두 일치합니다.");
  process.exit(0);
}

console.error("Expo SDK 가 기대하는 판과 다릅니다:\n");
for (const d of drift) {
  console.error(`  ${d.name}`);
  console.error(`      설치됨: ${d.have}`);
  console.error(`      기대:   ${d.expected}`);
}
console.error(`
${drift.length}개가 어긋났습니다.

네이티브 빌드는 이걸 한참 뒤에, 알아보기 어려운 모습으로 알려 줍니다
(C++ 에 없는 함수를 부른다든지). 여기서 미리 막습니다.

고치는 법: apps/mobile/package.json 의 "overrides" 에 기대 판을 적으세요.
다른 패키지가 최신을 요구해도 그 판으로 묶입니다.`);
process.exit(1);
