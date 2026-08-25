/** 노트 목록 — 검색(#태그 포함), 핀 우선, 새 노트. */
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, Small } from "../src/components/ui";
import { extractTags } from "../src/components/markdown";
import { CONTENT_MAX, radius, space, type, useTheme } from "../src/theme";
import { listNotes, type NoteRow } from "../src/db";

function fmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}.${d.getDate()}`;
}

export default function Notes() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(params.q ? String(params.q) : "");
  const [notes, setNotes] = useState<NoteRow[]>([]);

  // 편집기에서 돌아올 때마다 다시 읽는다.
  useFocusEffect(
    useCallback(() => {
      void listNotes(query).then(setNotes);
    }, [query]),
  );

  const allTags = useMemo(() => {
    const tags: string[] = [];
    for (const n of notes) for (const tag of extractTags(n.body)) {
      if (!tags.includes(tag)) tags.push(tag);
    }
    return tags.slice(0, 12);
  }, [notes]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.bottom,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="검색 (#태그 로 태그 검색)"
          placeholderTextColor={t.textMuted}
          autoCorrect={false}
          style={{
            flex: 1,
            color: t.text,
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            minHeight: 46,
            fontSize: 15,
          }}
        />
        <Button label="새 노트" tone="primary" onPress={() => router.push("/note/new")} />
      </View>

      {allTags.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {allTags.map((tag) => (
            <Pressable
              key={tag}
              accessibilityRole="button"
              onPress={() => setQuery(query === tag ? "" : tag)}
              style={({ pressed }) => ({
                paddingHorizontal: space.md,
                paddingVertical: 4,
                borderRadius: radius.full,
                backgroundColor: query === tag ? t.accent : t.surfaceAlt,
                transform: [{ scale: pressed ? 0.95 : 1 }],
              })}
            >
              <Text style={[type.caption, { color: query === tag ? "#FFFFFF" : t.textMuted }]}>
                {tag}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {notes.length === 0 ? (
        <Card>
          <Small>
            아직 노트가 없습니다. 학습 탭의 근무 보고서에서 &lsquo;노트로&rsquo;를 누르면
            보고서가 편집 가능한 노트가 됩니다. [[다른 노트]] 로 연결하고 #태그 로
            분류할 수 있습니다.
          </Small>
        </Card>
      ) : (
        notes.map((n) => (
          <Pressable
            key={n.id}
            accessibilityRole="button"
            onPress={() => router.push(`/note/${n.id}`)}
            style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.98 : 1 }] })}
          >
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                {n.pinned ? <Ionicons name="pin" size={14} color={t.accent} /> : null}
                <Text style={[type.cardTitle, { color: t.text, flex: 1 }]} numberOfLines={1}>
                  {n.title}
                </Text>
                <Text style={[type.caption, { color: t.textMuted }]}>{fmt(n.updatedAt)}</Text>
              </View>
              {n.body.trim() ? (
                <Text style={[type.small, { color: t.textMuted }]} numberOfLines={2}>
                  {n.body.replace(/[#>*`[\]-]/g, "").trim()}
                </Text>
              ) : null}
            </Card>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
