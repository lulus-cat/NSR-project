/**
 * 빌드에 박아 두는 키 — 개발자가 여기를 채워서 빌드하면 사용자는
 * 아무것도 입력하지 않아도 지도 검색·의약품 검색·모델 다운로드가 바로 된다.
 *
 * 우선순위: 사용자가 직접 넣은 키 > 여기 내장 키 > 저장소 app-config.json 공유 키.
 * app-config.json 은 앱을 다시 배포하지 않고 키를 바꾸는 비상구로 남겨 둔다.
 *
 * ── 난독화에 대한 정직한 설명 ──────────────────────────────
 * 키는 뒤집은 뒤 base64 로 저장한다. 이것은 **암호화가 아니다** — 앱이 쓰려면
 * 어차피 풀어야 하고, APK 를 받은 사람은 누구든 꺼낼 수 있다. 클라이언트 앱에
 * 넣는 키를 진짜로 숨기는 방법은 존재하지 않는다(숨겨야 하는 키는 서버에 둔다).
 * 이 난독화의 목적은 하나다: 공개 저장소를 긁어 평문 API 키를 자동 수확하는
 * 봇의 정규식에 안 걸리는 것. 그래서 결제 수단이 연결되지 않은 무료 키만 넣고,
 * 유료 AI 키(Claude·GPT·Kimi)는 절대 여기 두지 않는다 — 그건 기기의
 * 보안 저장소(SecureStore)에만 산다.
 *
 * 키가 도용되어 쿼터가 빨리면: 콘솔에서 재발급 → 새 키를 k1: 형태로
 * app-config.json 에 커밋하면 재배포 없이 모든 설치가 새 키로 넘어간다.
 * (인코딩 만들기: node -e "console.log('k1:'+Buffer.from([...'키'].reverse().join('')).toString('base64'))")
 */

/**
 * "k1:" + 뒤집은 base64 를 원문으로. app-config.json 의 값도 같은 형태다.
 * 접두사가 판별자다 — 평문 키도 우연히 유효한 base64 일 수 있어, atob 성공
 * 여부로는 인코딩 여부를 알 수 없다. 접두사 없는 값은 옛 평문으로 보고 그대로 쓴다.
 */
export function decodeKey(stored: string): string {
  if (!stored.startsWith("k1:")) return stored;
  try {
    return atob(stored.slice(3)).split("").reverse().join("");
  } catch {
    return "";
  }
}

export const BUILT_IN = {
  /** 카카오 REST API 키 (developers.kakao.com → 내 애플리케이션 → 앱 키). 근무지 검색. */
  kakaoKey: decodeKey("k1:NjE3Y2I1MjRkZmExMDQ2NzEyZTQzNzNiNzRiMWI3NzA="),
  /**
   * 공공데이터포털 일반 인증키. 심평원 병원 목록 + 식약처 e약은요.
   * 원문은 반드시 Decoding 형태(+, ==) — 요청 때 코드가 encodeURIComponent 를
   * 한 번 하므로, Encoding 형태(%2B…)면 이중 인코딩으로 인증이 깨진다.
   */
  publicDataKey: decodeKey(
    "k1:PT1RcUl3Z2w2ZVIzQlZicGx3ckxCakIzSDFwbkxwM01Bek1BbkZ6RzE1N09GRVlXM2p3MFZmNzB0dnpOdjRwQ0dMNkJLdFA0S1lMK2g5elZNNWpNNkJIcg==",
  ),
  /** HuggingFace 읽기 전용 토큰 (hf_...). 모델 다운로드가 429/401 로 막힐 때만 필요. */
  huggingFaceToken: "",
} as const;
