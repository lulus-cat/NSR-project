/**
 * 앱 진입점.
 *
 * OS 가 앱을 깨우는 일(근무지 감지·15분 점검)은 **화면보다 먼저** 정의돼 있어야
 * 한다. expo-router/entry 만 쓰면 화면이 떠서 모듈을 들일 때야 정의되는데, 앱을
 * 닫아 둔 사이에 신호가 오면 expo-task-manager 가 "정의 안 된 태스크" 로 보고
 * 등록을 지워 버린다. 그러면 앱을 다시 열기 전까지 자동 기록이 영영 안 돈다.
 *
 * 그래서 두 서비스를 여기서 먼저 들인다 (둘 다 모듈 최상단에서 defineTask 한다).
 */
import "./src/services/geofence";
import "./src/services/scheduler";
import "expo-router/entry";
