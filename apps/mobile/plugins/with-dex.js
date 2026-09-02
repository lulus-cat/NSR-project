/**
 * 삼성 DeX 대응 — 화면이 처음으로 되돌아가는 것을 막는다.
 *
 * DeX 로 들어가고 나올 때, 그리고 DeX 창 크기를 바꿀 때 안드로이드는 화면 밀도와
 * smallestScreenSize 를 바꾼다. 액티비티가 그 변화를 스스로 처리한다고 선언하지
 * 않으면 시스템이 액티비티를 부수고 다시 만든다. 리액트 트리가 통째로 다시
 * 마운트되니 화면 상태(고르던 것, 입력하던 것)가 전부 날아간다.
 *
 * 그래서 두 가지를 넣는다.
 *   1. configChanges 에 density·smallestScreenSize·fontScale 등을 더한다.
 *      expo prebuild 가 넣는 기본값에는 이 셋이 없다.
 *   2. 삼성이 따로 보는 메타데이터 두 개. keepalive.density 는 밀도가 바뀌어도
 *      액티비티를 살려 두라는 뜻이고, multidisplay.keep_process_alive 는 화면을
 *      옮길 때 프로세스를 죽이지 말라는 뜻이다. 삼성 기기에서만 읽고 나머지
 *      기기는 무시하므로 넣어서 손해 볼 것이 없다.
 *
 * android/ 는 커밋하지 않으므로(빌드 규칙) 이렇게 플러그인으로 넣는다.
 */
const { withAndroidManifest, AndroidConfig } = require("expo/config-plugins");

const CONFIG_CHANGES = [
  "keyboard",
  "keyboardHidden",
  "orientation",
  "screenSize",
  "screenLayout",
  "smallestScreenSize",
  "density",
  "fontScale",
  "uiMode",
  "navigation",
  "locale",
  "layoutDirection",
].join("|");

const SAMSUNG_META = [
  ["com.samsung.android.keepalive.density", "true"],
  ["com.samsung.android.multidisplay.keep_process_alive", "true"],
];

function upsertMeta(application, name, value) {
  application["meta-data"] = application["meta-data"] ?? [];
  const found = application["meta-data"].find((m) => m.$?.["android:name"] === name);
  if (found) found.$["android:value"] = value;
  else application["meta-data"].push({ $: { "android:name": name, "android:value": value } });
}

module.exports = function withDex(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);

    activity.$["android:configChanges"] = CONFIG_CHANGES;
    activity.$["android:resizeableActivity"] = "true";
    application.$["android:resizeableActivity"] = "true";
    for (const [name, value] of SAMSUNG_META) upsertMeta(application, name, value);

    return cfg;
  });
};
