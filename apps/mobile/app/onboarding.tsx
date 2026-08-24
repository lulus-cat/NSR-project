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
    title: "내가 없는 자리의 대화는 녹음하면 안 됩니다",
    body:
      "통신비밀보호법은 '공개되지 아니한 타인간의 대화'의 녹음을 금지합니다. 내가 참여한 대화(인계, 나에게 하는 말)는 녹음해도 되지만, 내가 없는 자리에서 남들끼리 나눈 대화가 녹음되면 위법이며 벌금형 없이 1년 이상의 징역형 대상입니다. 그래서 기기를 몸에 지녀야 하고, 앱은 본인 음성이 없는 구간을 자동으로 버립니다.",
  },
  {
    key: "medical",
    title: "녹음에는 환자 정보가 들어갑니다",
    body:
      "의료법 제19조는 업무상 알게 된 정보의 누설을 금지합니다. 이 앱은 전사와 분석을 기기 안에서 처리하고, 외부 전송은 기본으로 꺼져 있습니다. 내보내기·공유를 할 때는 항상 한 번 더 생각해 주세요.",
  },
  {
    key: "hospital",
    title: "병원 내규로 금지되어 있을 수 있습니다",
    body:
      "법을 어기지 않아도 취업규칙 위반으로 징계 사유가 될 수 있습니다. 대부분의 병원이 원내 무단 녹음을 금지하는 내규를 두고 있습니다. 이건 앱이 해결해줄 수 없는 문제이며, 알고 선택하셔야 합니다.",
  },
  {
    key: "indicator",
    title: "마이크 표시는 끌 수 없습니다",
    body:
      "iOS의 주황색 점, Android의 마이크 아이콘은 OS가 강제하는 것이라 어떤 앱도 끌 수 없습니다. 앱은 소리·진동·알림을 전부 없애고 화면이 꺼진 채로 동작하지만, OS 표시는 남습니다.",
  },
  {
    key: "score",
    title: "태움 지표는 판정이 아니라 기록입니다",
    body:
      "어조·표정·맥락은 텍스트에 남지 않습니다. 점수는 '이 근무를 다시 볼 필요가 있는가'를 알려주는 표시등이고, 본체는 그 아래의 인용문입니다. 신고나 상담을 고려한다면 전문가와 상의하세요.",
  },
  {
    key: "device",
    title: "기기를 잃어버리면 그 안의 정보도 나갑니다",
    body:
      "그래서 앱 잠금을 켜는 것을 강하게 권합니다. 보관기간이 지난 녹음은 자동으로 지워집니다. 오래된 녹음을 쌓아두는 것이 가장 큰 위험입니다.",
  },
];

export default function Onboarding() {
  const t = useTheme();
  const app = useApp();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const allChecked = ITEMS.every((i) => checked[i.key]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <View style={{ gap: space.xs, marginBottom: space.sm }}>
          <Text style={[type.title, { color: t.text }]}>시작하기 전에</Text>
          <Small>
            여섯 가지를 먼저 확인해 주세요. 하나씩 읽고 체크해야 다음으로 넘어갑니다.
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
          label={allChecked ? "확인했습니다" : "위 항목을 모두 읽어주세요"}
          tone="primary"
          disabled={!allChecked}
          onPress={() => void app.completeOnboarding()}
        />
        <Small>
          녹음 기능은 기본으로 꺼져 있습니다. 설정에서 직접 켜야 시작됩니다.
        </Small>
      </ScrollView>
    </SafeAreaView>
  );
}
