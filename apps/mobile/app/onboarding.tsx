import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, Card, Heading, Small } from "../src/components/ui";
import { useApp } from "../src/state/AppContext";
import { radius, space, type, useTheme } from "../src/theme";
import { Text } from "react-native";

/**
 * 최초 고지.
 *
 * 약관 하단에 묻어두지 않는다. 항목마다 따로 체크하게 만든다.
 * 이 중 첫 번째 항목은 형사처벌 가능성에 관한 것이라 특히 그렇다.
 * (docs/01-legal-and-privacy.md)
 */
const ITEMS: { key: string; title: string; body: string }[] = [
  {
    key: "wiretap",
    title: "당사자가 아닌 타인 간 대화 녹음 금지",
    body:
      "통신비밀보호법상 본인이 참여하지 않은 타인 간 대화 녹음은 불법이며 1년 이상 징역형 대상입니다. 항상 기기를 휴대해야 하며, 앱은 무음 및 타인 전용 구간을 자동 폐기합니다.",
  },
  {
    key: "medical",
    title: "녹음 내 환자 개인정보 포함 주의",
    body:
      "의료법 제19조는 업무상 비밀 누설을 금지합니다. 모든 데이터는 기기 내에서 처리되며 외부 송신은 기본 차단됩니다. 공유 및 내보내기 시 신중을 기하십시오.",
  },
  {
    key: "hospital",
    title: "원내 규정에 따른 녹음 금지 확인",
    body:
      "취업규칙상 원내 무단 녹음은 징계 사유가 될 수 있습니다. 병원별 내규를 반드시 사전에 확인하십시오.",
  },
  {
    key: "indicator",
    title: "OS 마이크 상태 표시 안내",
    body:
      "iOS 주황색 표시와 Android 마이크 아이콘은 OS 필수 시스템 표시입니다. 앱 자체 소리·진동은 없으나 OS 상태 아이콘은 숨길 수 없습니다.",
  },
  {
    key: "score",
    title: "태움 지표는 판정이 아니라 기록입니다",
    body:
      "텍스트만으로는 어조나 맥락이 담기지 않습니다. 점수는 참고용 지표이며 실제 발언 인용문 확인이 필요합니다. 문제 발생 시 전문가와 상담하십시오.",
  },
  {
    key: "device",
    title: "기기 분실 시 데이터 유출 주의",
    body:
      "개인정보 보호를 위해 앱 잠금 사용을 권장합니다. 보관 기간이 만료된 녹음 파일은 자동 삭제됩니다.",
  },
  {
    key: "alpha",
    title: "알파 버전 안내",
    body:
      "알파 버전은 기능 및 저장 형식이 변경될 수 있습니다. 중요 녹음 파일은 별도로 백업하십시오." +
      "화자(발언자)는 자동 분리되지 않습니다 — 온디바이스 Whisper는" +
      "음성을 구별하지 못합니다. 전사 탭에서 화자 구간을 직접 지정해야 근무 환경 지표가 집계됩니다." +
      "전사 기능을 이용하려면 설정에서 모델을 먼저 다운로드해야 합니다.",
  },
];

export default function Onboarding() {
  const t = useTheme();
  const app = useApp();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // 동의 직후 홈으로 넘어가며 DB·스케줄러가 뜨느라 몇 초 멈춘다.
  // 아무 표시가 없으면 안 눌린 줄 알고 다시 누른다.
  const [starting, setStarting] = useState(false);
  const allChecked = ITEMS.every((i) => checked[i.key]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <View style={{ gap: space.xs, marginBottom: space.sm }}>
          <Text style={[type.title, { color: t.text }]}>시작하기 전에</Text>
          <Small>
            
  6가지 필수 사항을 확인하십시오. 모든 항목에 동의해야 진행할 수 있습니다.
</Small>
        </View>

        {ITEMS.map((item) => {
          const on = !!checked[item.key];
          return (
            <Pressable
              key={item.key}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              onPress={() => setChecked((c) => ({ ...c, [item.key]: !c[item.key] }))}
            >
              <Card tone={on ? "accent" : "default"}>
                <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start" }}>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: radius.sm,
                      borderWidth: 2,
                      borderColor: on ? t.accent : t.border,
                      backgroundColor: on ? t.accent : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                      marginTop: 2,
                    }}
                  >
                    {on ? <Text style={{ color: "#fff", fontWeight: "700" }}>✓</Text> : null}
                  </View>
                  <View style={{ flex: 1, gap: space.xs }}>
                    <Heading>{item.title}</Heading>
                    <Body muted>{item.body}</Body>
                  </View>
                </View>
              </Card>
            </Pressable>
          );
        })}

        <Button
          label={starting ? "준비하는 중" : allChecked ? "확인했습니다" : "위 항목을 모두 확인하십시오."}
          tone="primary"
          disabled={!allChecked || starting}
          busy={starting}
          onPress={() => {
            setStarting(true);
            void app.completeOnboarding();
          }}
        />
        <Small>
          
  녹음 기능은 기본으로 비활성화되어 있습니다. 설정에서 직접 활성화하십시오.
</Small>
      </ScrollView>
    </SafeAreaView>
  );
}
