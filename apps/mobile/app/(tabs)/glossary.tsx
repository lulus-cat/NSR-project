import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import {
  OFFICIAL_SOURCES,
  buildLexicon,
  searchSources,
  sourcesForTerm,
  type LexiconEntry,
  type TermCategory,
  type WardPack,
} from "@nsr/core";
import { Badge, Body, Card, Divider, Heading, Small, HeaderScreen } from "../../src/components/ui";
import { radius, space, type, useTheme } from "../../src/theme";
import { enabledWardPacks, listUserTerms } from "../../src/db";
import { searchDrug, type DrugInfo } from "../../src/services/publicdata";
import { Button } from "../../src/components/ui";

const CATEGORY_LABELS: Record<TermCategory, string> = {
  assessment: "사정",
  procedure: "처치",
  device: "기구",
  medication: "투약",
  lab: "검사",
  condition: "상태",
  emergency: "응급",
  documentation: "기록",
  workflow: "업무",
  role: "역할",
  shift: "근무",
};

type Tab = "terms" | "drugs" | "sources";

export default function Glossary() {
  const t = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("terms");
  const [query, setQuery] = useState("");
  const [userTerms, setUserTerms] = useState<LexiconEntry[]>([]);
  const [packs, setPacks] = useState<WardPack[]>([]);
  const [drugs, setDrugs] = useState<DrugInfo[] | null>(null);
  const [drugMsg, setDrugMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    // 화면과 전사가 같은 사전을 봐야 한다. 병동 사전도 함께 싣는다.
    const [terms, wardPacks] = await Promise.all([listUserTerms(), enabledWardPacks()]);
    setUserTerms(terms);
    setPacks(wardPacks);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const lexicon = useMemo(
    () => buildLexicon({ userTerms, packs }),
    [userTerms, packs],
  );

  const terms = useMemo(() => {
    if (!query.trim()) return lexicon.entries.slice(0, 60);
    return lexicon.search(query, 40);
  }, [lexicon, query]);

  const sources = useMemo(() => {
    if (!query.trim()) return OFFICIAL_SOURCES;
    return searchSources(query, 20);
  }, [query]);

  return (
    <HeaderScreen title="용어와 자료">
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={
          tab === "terms"
            ? "용어 검색 (예: 폴리, 엔피오, 욕창)"
            : tab === "drugs"
              ? "약 이름 (예: 타이레놀, 라식스)"
              : "자료 검색"
        }
        placeholderTextColor={t.textMuted}
        autoCorrect={false}
        style={{
          color: t.text,
          backgroundColor: t.surfaceAlt,
          borderRadius: radius.md,
          padding: space.md,
          fontSize: 15,
        }}
      />

      <View style={{ flexDirection: "row", gap: space.sm }}>
        {(["terms", "drugs", "sources"] as Tab[]).map((key) => {
          const on = tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => setTab(key)}
              style={({ pressed }) => ({
                paddingVertical: space.sm,
                paddingHorizontal: space.lg,
                borderRadius: radius.sm,
                backgroundColor: on ? t.accent : t.surfaceAlt,
                transform: [{ scale: pressed ? 0.95 : 1 }],
              })}
            >
              <Text style={{ color: on ? "#fff" : t.text, fontWeight: "600", fontSize: 14 }}>
                {key === "terms" ? "용어·은어" : key === "drugs" ? "의약품" : "공식 자료"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "terms" ? (
        <>
          <Small>
            
  들리는 대로 찾아도 맞는 말을 찾아줘요. (예: 카데타 → 카테터)
</Small>
          {terms.map((entry) => {
            const open = expanded === entry.id;
            const linked = open ? sourcesForTerm(entry) : [];
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                onPress={() => setExpanded(open ? null : entry.id)}
              >
                <Card>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: space.sm,
                    }}
                  >
                    <Heading>
                      {entry.ko}
                      {entry.abbr ? ` (${entry.abbr})` : ""}
                    </Heading>
                    <Badge text={CATEGORY_LABELS[entry.category]} tone="muted" />
                  </View>
                  <Body muted>{entry.definition}</Body>

                  {entry.informal && entry.formal ? (
                    <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                      <Badge text="은어" tone="warn" />
                      <Small>기록에는 &ldquo;{entry.formal}&rdquo;</Small>
                    </View>
                  ) : null}

                  {open ? (
                    <>
                      <Divider />
                      {entry.pitfall ? (
                        <View style={{ gap: space.xs }}>
                          <Small muted={false}>자주 놓치는 지점</Small>
                          <Body>{entry.pitfall}</Body>
                        </View>
                      ) : null}
                      {entry.aliases.length > 0 ? (
                        <Small>이렇게도 부릅니다: {entry.aliases.join(", ")}</Small>
                      ) : null}
                      {linked.length > 0 ? (
                        <View style={{ gap: space.xs, marginTop: space.sm }}>
                          <Small muted={false}>근거 자료</Small>
                          {linked.map((s) => (
                            <Pressable
                              key={s.id}
                              accessibilityRole="link"
                              onPress={() => void Linking.openURL(s.url)}
                            >
                              <Text style={[type.small, { color: t.accent }]}>
                                {s.name} — {s.publisher}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                    </>
                  ) : null}
                </Card>
              </Pressable>
            );
          })}
          {terms.length === 0 ? (
            <Card>
              <Body muted>
                
  찾는 말이 없어요. 병동마다 부르는 말이 달라요.
</Body>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push("/ward-dict")}
              >
                <Text style={[type.small, { color: t.accent }]}>
                  
  병동 사전에 이 용어 추가하기 →
</Text>
              </Pressable>
              <Divider />
              <Small>약 이름은 위 의약품 탭에서 찾아요.</Small>
            </Card>
          ) : null}
        </>
      ) : tab === "drugs" ? (
        <>
          <Small>
            약 이름으로 효능·용법·주의사항을 찾아요. 제품 이름이 정확할수록 잘 찾아요.
          </Small>
          <Button
            label="검색"
            tone="primary"
            disabled={query.trim().length < 2}
            onPress={async () => {
              setDrugMsg(null);
              setDrugs(null);
              try {
                const found = await searchDrug(query);
                if (found === null) {
                  setDrugMsg(
                    "공공데이터 열쇠가 없어요. 설정에서 넣어 주세요.",
                  );
                } else if (found.length === 0) {
                  setDrugMsg("찾지 못했어요. 정확한 제품 이름으로 다시 찾아 주세요.");
                } else {
                  setDrugs(found);
                }
              } catch (e) {
                setDrugMsg(e instanceof Error ? e.message : "찾지 못했어요. 인터넷 연결을 확인해 주세요.");
              }
            }}
          />
          {drugMsg ? <Small muted={false}>{drugMsg}</Small> : null}
          {drugs?.map((d) => (
            <Card key={d.name}>
              <Heading>{d.name}</Heading>
              <Small>{d.company} · 식약처 e약은요</Small>
              {d.effect ? (
                <>
                  <Small muted={false}>효능</Small>
                  <Body muted>{d.effect}</Body>
                </>
              ) : null}
              {d.usage ? (
                <>
                  <Small muted={false}>용법</Small>
                  <Body muted>{d.usage}</Body>
                </>
              ) : null}
              {d.caution ? (
                <>
                  <Small muted={false}>주의</Small>
                  <Body muted>{d.caution}</Body>
                </>
              ) : null}
            </Card>
          ))}
        </>
      ) : (
        <>
          <Small>
            
  공식 지침은 여기서 확인해요. 저작권 때문에 링크만 남겨요.
</Small>
          {sources.map((s) => (
            <Pressable
              key={s.id}
              accessibilityRole="link"
              onPress={() => void Linking.openURL(s.url)}
            >
              <Card>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: space.sm,
                  }}
                >
                  <Heading>{s.name}</Heading>
                  {s.access !== "free" ? (
                    <Badge text={s.access === "member" ? "기관 계정" : "유료"} tone="muted" />
                  ) : null}
                </View>
                <Small>{s.publisher}</Small>
                <Body muted>{s.description}</Body>
                {s.caution ? (
                  <View style={{ gap: space.xs }}>
                    <Badge text="주의" tone="warn" />
                    <Small>{s.caution}</Small>
                  </View>
                ) : null}
                <Text style={[type.small, { color: t.accent }]}>{s.url}</Text>
              </Card>
            </Pressable>
          ))}
        </>
      )}
    </HeaderScreen>
  );
}
