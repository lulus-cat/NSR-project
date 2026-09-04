/**
 * 노트 편집기 — 옵시디언의 부분집합, 이제 라이브 편집.
 *
 * 편집 중에도 마크다운이 색·굵기로 보인다(markdown-editor). 서식은 아래
 * 도구 줄로 선택 영역에 바로 먹인다 — 문법을 몰라도 문서처럼 쓸 수 있다.
 * '문서' 보기는 완성본 판형(제목 크기·체크박스·콜아웃)이고, 같은 판형이
 * PDF(A4 · 여백 1.17in · 줄간 1.4)로 나간다.
 *
 * [[위키링크]]는 문서 보기에서 눌러 이동하고, 백링크는 맨 아래에 모인다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps } from "react";
import { Card, Small } from "../../src/components/ui";
import { Markdown, extractTags } from "../../src/components/markdown";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../../src/components/markdown-editor";
import { exportNotePdf } from "../../src/services/note-doc";
import { CONTENT_MAX, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import {
  deleteNote,
  getNote,
  getNoteByTitle,
  notesLinkingTo,
  saveNote,
  type NoteRow,
} from "../../src/db";

/** 서식 도구 — 커서/선택 위치에 바로 먹는다. */
const TOOLS: {
  key: string;
  icon?: ComponentProps<typeof Ionicons>["name"];
  label?: string;
  hint: string;
  run: (e: MarkdownEditorHandle) => void;
}[] = [
  { key: "h2", label: "제목", hint: "제목 (## )", run: (e) => e.toggleLinePrefix("## ") },
  { key: "h3", label: "소제목", hint: "소제목 (### )", run: (e) => e.toggleLinePrefix("### ") },
  { key: "bold", label: "굵게", hint: "굵게 (**)", run: (e) => e.wrapSelection("**") },
  { key: "italic", label: "기울임", hint: "기울임 (*)", run: (e) => e.wrapSelection("*") },
  { key: "code", label: "코드", hint: "코드 (`)", run: (e) => e.wrapSelection("`") },
  { key: "list", icon: "list", hint: "글머리 목록", run: (e) => e.toggleLinePrefix("- ") },
  { key: "num", label: "1.", hint: "번호 목록", run: (e) => e.toggleLinePrefix("1. ") },
  { key: "task", icon: "checkbox-outline", hint: "할 일", run: (e) => e.toggleLinePrefix("- [ ] ") },
  { key: "quote", label: "인용", hint: "인용 (>)", run: (e) => e.toggleLinePrefix("> ") },
  { key: "hr", label: "―", hint: "구분선", run: (e) => e.insert("\n---\n") },
  { key: "link", label: "[[링크]]", hint: "노트 연결", run: (e) => e.insert("[[]]") },
  { key: "tag", label: "#태그", hint: "태그", run: (e) => e.insert("#") },
  { key: "callout", label: "주의", hint: "주의 블록", run: (e) => e.toggleLinePrefix("> [!주의] ", ["> [!주의] ", "> "]) },
];

export default function NoteEditor() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; title?: string; seed?: string }>();
  const [noteId, setNoteId] = useState<string | null>(params.id === "new" ? null : params.id);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);
  const [backlinks, setBacklinks] = useState<NoteRow[]>([]);
  const [busyPdf, setBusyPdf] = useState(false);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
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
          // 내용이 있는 노트는 문서 보기부터 — 읽으러 오는 경우가 더 많다.
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

  const changeBody = useCallback(
    (v: string) => {
      setBody(v);
      scheduleSave({ body: v });
    },
    [scheduleSave],
  );

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

  const runPdf = useCallback(async () => {
    setBusyPdf(true);
    try {
      await persist();
      await exportNotePdf(title, body);
    } catch (e) {
      Alert.alert("PDF 를 만들지 못했어요", e instanceof Error ? e.message : "잠시 뒤 다시 해 주세요.");
    } finally {
      setBusyPdf(false);
    }
  }, [body, persist, title]);

  const tags = extractTags(body);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{
        padding: space.lg,
        // 스택 화면 — 내비게이션 바 안전영역만큼 띄운다.
        paddingBottom: space.lg + insets.bottom,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
      keyboardShouldPersistTaps="handled"
    >
      {/* 제목 + 도구 */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
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
          accessibilityLabel="PDF로 내보내기"
          disabled={busyPdf}
          onPress={() => void runPdf()}
          style={({ pressed }) => ({ padding: space.sm, opacity: pressed || busyPdf ? 0.5 : 1 })}
        >
          <Ionicons name="print-outline" size={20} color={t.textMuted} />
        </Pressable>
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
            Alert.alert("이 노트를 지울까요", "지우면 되살릴 수 없어요.", [
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

      {/* 편집 | 문서 전환 */}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {(
          [
            [false, "편집"],
            [true, "문서"],
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
            <Small>내용이 없어요. 고치기 버튼을 눌러 적어요.</Small>
          )}
        </Card>
      ) : (
        <>
          {/* 서식 도구 줄 — 가로 스크롤. 선택 영역/커서 줄에 바로 먹는다. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={{ gap: space.xs, paddingVertical: 2 }}
          >
            {TOOLS.map((tool) => (
              <Pressable
                key={tool.key}
                accessibilityRole="button"
                accessibilityLabel={tool.hint}
                onPress={() => {
                  if (editorRef.current) tool.run(editorRef.current);
                }}
                style={({ pressed }) => ({
                  minHeight: TOUCH_MIN,
                  minWidth: TOUCH_MIN,
                  paddingHorizontal: space.md,
                  borderRadius: radius.md,
                  backgroundColor: pressed ? t.accentSoft : t.surfaceAlt,
                  alignItems: "center",
                  justifyContent: "center",
                })}
              >
                {tool.icon ? (
                  <Ionicons name={tool.icon} size={17} color={t.text} />
                ) : (
                  <Text
                    style={[
                      type.small,
                      {
                        color: t.text,
                        fontWeight: tool.key === "bold" ? "800" : "600",
                        fontStyle: tool.key === "italic" ? "italic" : "normal",
                      },
                    ]}
                  >
                    {tool.label}
                  </Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
          <MarkdownEditor
            ref={editorRef}
            value={body}
            onChange={changeBody}
            placeholder={
              "여기에 적어요. 쓰는 동안에도 모양이 보여요.\n\n## 제목\n- 목록\n- [ ] 할 일\n[[다른 노트]] 로 연결, #태그 로 분류"
            }
          />
          <Small>
            고칠 때는 글자 크기가 같아 보여요. 실제 모양은 문서 보기와 PDF 에서 보여요.
          </Small>
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
