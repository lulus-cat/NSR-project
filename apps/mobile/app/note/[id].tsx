/**
 * 노트 편집기 — 옵시디언의 부분집합.
 *
 * 편집(일반 텍스트)과 보기(마크다운 렌더)를 오간다. 보기에서
 * [[위키링크]]를 누르면 그 제목의 노트로 가고, 없으면 만든다.
 * 백링크(이 노트를 참조하는 노트)는 맨 아래에 모인다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, Small } from "../../src/components/ui";
import { Markdown, extractTags } from "../../src/components/markdown";
import { CONTENT_MAX, radius, space, type, useTheme } from "../../src/theme";
import {
  deleteNote,
  getNote,
  getNoteByTitle,
  notesLinkingTo,
  saveNote,
  type NoteRow,
} from "../../src/db";

/** 커서 위치를 모르는 대신 본문 끝에 문법 조각을 붙여 주는 도구 줄. */
const SNIPPETS: { label: string; insert: string }[] = [
  { label: "[[링크]]", insert: "[[]]" },
  { label: "#태그", insert: "#" },
  { label: "☐ 할 일", insert: "\n- [ ] " },
  { label: "주의 블록", insert: "\n> [!주의] " },
  { label: "제목", insert: "\n## " },
];

export default function NoteEditor() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; title?: string; seed?: string }>();
  const [noteId, setNoteId] = useState<string | null>(params.id === "new" ? null : params.id);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);
  const [backlinks, setBacklinks] = useState<NoteRow[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    void (async () => {
      if (params.id !== "new") {
        const n = await getNote(params.id);
        if (n) {
          setTitle(n.title);
          setBody(n.body);
          setPinned(n.pinned);
          setBacklinks(await notesLinkingTo(n.title, n.id));
          // 내용이 있는 노트는 보기부터 — 읽으러 오는 경우가 더 많다.
          if (n.body.trim()) setPreview(true);
        }
      } else {
        if (params.title) setTitle(String(params.title));
        if (params.seed) setBody(String(params.seed));
      }
      loaded.current = true;
    })();
    // params.id 로만 다시 연다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const persist = useCallback(
    async (next?: { title?: string; body?: string; pinned?: boolean }) => {
      if (!loaded.current) return;
      const id = await saveNote({
        id: noteId ?? undefined,
        title: next?.title ?? title,
        body: next?.body ?? body,
        pinned: next?.pinned ?? pinned,
      });
      if (!noteId) setNoteId(id);
    },
    [noteId, title, body, pinned],
  );

  // 자동 저장 — 타자 멈추고 800ms 뒤. 화면을 떠나도 마지막 상태가 남는다.
  const scheduleSave = useCallback(
    (next: { title?: string; body?: string }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void persist(next), 800);
    },
    [persist],
  );
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const openLink = useCallback(
    async (target: string) => {
      await persist();
      const existing = await getNoteByTitle(target);
      if (existing) {
        router.push(`/note/${existing.id}`);
      } else {
        const id = await saveNote({ title: target, body: "" });
        router.push(`/note/${id}`);
      }
    },
    [persist, router],
  );

  const toggleTask = useCallback(
    (line: number, next: boolean) => {
      const lines = body.split("\n");
      lines[line] = lines[line].replace(/- \[( |x|X)\]/, next ? "- [x]" : "- [ ]");
      const nb = lines.join("\n");
      setBody(nb);
      void persist({ body: nb });
    },
    [body, persist],
  );

  const tags = extractTags(body);

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
      {/* 제목 + 도구 */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <TextInput
          value={title}
          onChangeText={(v) => {
            setTitle(v);
            scheduleSave({ title: v });
          }}
          placeholder="제목"
          placeholderTextColor={t.textMuted}
          style={[type.heading, { flex: 1, color: t.text, paddingVertical: space.sm }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={pinned ? "핀 해제" : "핀 고정"}
          onPress={() => {
            setPinned(!pinned);
            void persist({ pinned: !pinned });
          }}
          style={({ pressed }) => ({ padding: space.sm, opacity: pressed ? 0.6 : 1 })}
        >
          <Ionicons name={pinned ? "pin" : "pin-outline"} size={20} color={pinned ? t.accent : t.textMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="삭제"
          onPress={() => {
            Alert.alert("노트 삭제", "이 노트를 지웁니다. 복구할 수 없습니다.", [
              { text: "취소", style: "cancel" },
              {
                text: "삭제",
                style: "destructive",
                onPress: async () => {
                  if (noteId) await deleteNote(noteId);
                  router.back();
                },
              },
            ]);
          }}
          style={({ pressed }) => ({ padding: space.sm, opacity: pressed ? 0.6 : 1 })}
        >
          <Ionicons name="trash-outline" size={19} color={t.textMuted} />
        </Pressable>
      </View>

      {/* 편집 | 보기 전환 */}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {(
          [
            [false, "편집"],
            [true, "보기"],
          ] as const
        ).map(([mode, label]) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            onPress={() => {
              if (mode) void persist();
              setPreview(mode);
            }}
            style={({ pressed }) => ({
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
              borderRadius: radius.full,
              backgroundColor: preview === mode ? t.accent : t.surfaceAlt,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            })}
          >
            <Text
              style={[type.small, { color: preview === mode ? "#FFFFFF" : t.text, fontWeight: "600" }]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        {tags.slice(0, 3).map((tag) => (
          <Text key={tag} style={[type.small, { color: t.accent, alignSelf: "center" }]}>
            {tag}
          </Text>
        ))}
      </View>

      {preview ? (
        <Card>
          {body.trim() ? (
            <Markdown
              text={body}
              handlers={{
                onLink: (target) => void openLink(target),
                onTag: (tag) => router.push({ pathname: "/notes", params: { q: tag } }),
                onToggleTask: toggleTask,
              }}
            />
          ) : (
            <Small>내용이 없습니다. 편집 버튼을 눌러 작성해 보십시오.</Small>
          )}
        </Card>
      ) : (
        <>
          <TextInput
            value={body}
            onChangeText={(v) => {
              setBody(v);
              scheduleSave({ body: v });
            }}
            multiline
            textAlignVertical="top"
            placeholder={"내용을 적습니다.\n\n## 제목\n- 목록\n- [ ] 할 일\n[[다른 노트]] 로 연결, #태그 로 분류\n> [!주의] 콜아웃"}
            placeholderTextColor={t.textMuted}
            style={{
              minHeight: 320,
              color: t.text,
              backgroundColor: t.surface,
              borderRadius: radius.lg,
              padding: space.lg,
              fontSize: 15,
              lineHeight: 23,
            }}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {SNIPPETS.map((s) => (
              <Pressable
                key={s.label}
                accessibilityRole="button"
                onPress={() => {
                  const nb = body + s.insert;
                  setBody(nb);
                  scheduleSave({ body: nb });
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  borderRadius: radius.md,
                  backgroundColor: t.surfaceAlt,
                  transform: [{ scale: pressed ? 0.95 : 1 }],
                })}
              >
                <Text style={[type.small, { color: t.text }]}>{s.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {/* 백링크 */}
      {backlinks.length > 0 ? (
        <Card>
          <Small muted={false}>이 노트를 참조하는 노트 {backlinks.length}</Small>
          {backlinks.map((n) => (
            <Pressable
              key={n.id}
              accessibilityRole="button"
              onPress={() => router.push(`/note/${n.id}`)}
              style={({ pressed }) => ({ paddingVertical: space.sm, opacity: pressed ? 0.6 : 1 })}
            >
              <Text style={[type.body, { color: t.accent }]}>{n.title}</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}
