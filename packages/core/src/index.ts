/**
 * NSR core — 신규간호사 적응 지원 앱의 도메인 로직.
 *
 * 이 패키지는 플랫폼에 의존하지 않는다. React Native도, Node도, 파일시스템도 모른다.
 * 순수 함수와 데이터만 있고 전부 단위 테스트로 검증된다.
 * 녹음·저장·화면은 apps/mobile이 담당한다.
 */
export * from "./hangul/index.js";
export * from "./lexicon/index.js";
export * from "./transcription/index.js";
export * from "./taeum/index.js";
export * from "./study/index.js";
export * from "./duty/index.js";
export * from "./sources/index.js";
export * from "./release/index.js";
