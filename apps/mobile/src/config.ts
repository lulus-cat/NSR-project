/**
 * 빌드에 박아 두는 키 — 개발자가 여기를 채워서 빌드하면 사용자는
 * 아무것도 입력하지 않아도 지도 검색·의약품 검색·모델 다운로드가 바로 된다.
 *
 * 우선순위: 사용자가 직접 넣은 키 > 여기 내장 키 > 저장소 app-config.json 공유 키.
 * app-config.json 은 앱을 다시 배포하지 않고 키를 바꾸는 비상구로 남겨 둔다.
 *
 * 공개 저장소이므로 여기 넣은 키는 APK 에서도 저장소에서도 공개된다.
 * 결제 수단이 연결되지 않은 무료 키만 넣는다. 허깅페이스 토큰은 반드시
 * "읽기 전용(fine-grained, read-only)" 으로 만들어 넣는다 — 계정 토큰이라
 * 쓰기 권한이 있으면 남이 내 저장소를 지울 수 있다. 공개 모델만 쓰면 비워 둔다.
 */
export const BUILT_IN = {
  /** 카카오 REST API 키 (developers.kakao.com → 내 애플리케이션 → 앱 키). 근무지 검색. */
  kakaoKey: "077b1b47b3734e2176401afd425bc716",
  /**
   * 공공데이터포털 일반 인증키. 심평원 병원 목록 + 식약처 e약은요.
   * 반드시 Decoding 형태(+, ==)로 둔다 — 요청 때 코드가 encodeURIComponent 를
   * 한 번 하므로, Encoding 형태(%2B…)를 넣으면 이중 인코딩으로 인증이 깨진다.
   */
  publicDataKey:
    "rHB6Mj5MVz9h+LYK4PtKB6LGCp4vNzvt07fV0wj3WYEFO751GzFnAMzAM3pLnp1H3BjBLrwlpbVB3Re6lgwIqQ==",
  /** HuggingFace 읽기 전용 토큰 (hf_...). 모델 다운로드가 429/401 로 막힐 때만 필요. */
  huggingFaceToken: "",
} as const;
