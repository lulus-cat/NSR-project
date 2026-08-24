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
import { Badge, Body, Card, Divider, Heading, Small } from "../../src/components/ui";
import { radius, space, type, useTheme } from "../../src/theme";
import { enabledWardPacks, listUserTerms } from "../../src/db";

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

type Tab = "terms" | "sources";

export default function Glossary() {
  const t = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("terms");
  const [query, setQuery] = useState("");
  const [userTerms, setUserTerms] = useState<LexiconEntry[]>([]);
  const [packs, setPacks] = useState<WardPack[]>([]);
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
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.bottom }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={tab === "terms" ? "용어 검색 (예: 폴리, 엔피오, 욕창)" : "자료 검색"}
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
        {(["terms", "sources"] as Tab[]).map((key) => {
          const on = tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => setTab(key)}
              style={{
                paddingVertical: space.sm,
                paddingHorizontal: space.lg,
                borderRadius: radius.sm,
                backgroundColor: on ? t.accent : t.surfaceAlt,
              }}
            >
              <Text style={{ color: on ? "#fff" : t.text, fontWeight: "600", fontSize: 14 }}>
                {key === "terms" ? "용어·은어" : "공식 자료"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "terms" ? (
        <>
          <Small>
            검색은 발음으로도 됩니다. "카데타"라고 쳐도 "카테터"가 나옵니다.
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
                찾는 말이 없습니다. 병동마다 쓰는 말이 다릅니다.
              </Body>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push("/ward-dict")}
              >
                <Text style={[type.small, { color: t.accent }]}>
                  병동 사전에 이 말을 담으러 가기 →
                </Text>
              </Pressable>
            </Card>
          ) : null}
        </>
      ) : (
        <>
          <Small>
            검색 상단에 뜨는 블로그 대신 여기서 시작하세요. 지침 본문은 각 기관에 저작권이 있어
            앱은 링크만 보관합니다.
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
    </ScrollView>
  );
}
