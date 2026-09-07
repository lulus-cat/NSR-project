/**
 * 노트 편집기 — 보기와 고치기가 한 화면이다.
 *
 * 예전에는 '편집' 과 '문서' 를 오갔다. 큰 메모앱들은 그러지 않는다 —
 * 늘 완성된 모양이고, 손댄 자리만 글자로 열린다. markdown-editor 가 그
 * 방식(블록 편집)이라 이 화면에는 전환 버튼이 없다.
 *
 * 서식은 아래 도구 줄로 커서 자리에 바로 먹인다 — 문법을 몰라도 쓸 수 있다.
 * 같은 판형이 PDF(A4 · 여백 1.17in · 줄간 1.4)로 나간다.
 * [[위키링크]]는 눌러 이동하고, 백링크는 맨 아래에 모인다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps } from "react";
import { Card, Small } from "../../src/components/ui";
import { extractTags } from "../../src/components/markdown";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../../src/components/markdown-editor";
import { exportNotePdf } from "../../src/services/note-doc";
import { redactForExport } from "../../src/services/export";
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
  {
    key: "table",
    icon: "grid-outline",
    hint: "표",
    run: (e) => e.insert("\n| 항목 | 내용 |\n| --- | --- |\n|  |  |\n"),
  },
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
  //
  // 떠날 때 **기다리던 저장을 흘려보낸다.** 예전에는 타이머만 끄고 나가서,
  // 마지막 0.8초 안에 친 글자가 조용히 사라졌다 (뒤로 가기, 앱 잠금, 탭 이동).
  const pending = useRef<{ title?: string; body?: string } | null>(null);
  const scheduleSave = useCallback(
    (next: { title?: string; body?: string }) => {
      pending.current = { ...pending.current, ...next };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const queued = pending.current;
        pending.current = null;
        void persist(queued ?? next);
      }, 800);
    },
    [persist],
  );
  // persist 는 최신 값을 봐야 한다. 떠나는 순간의 것을 ref 로 들고 있는다.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pending.current) {
        const queued = pending.current;
        pending.current = null;
        void persistRef.current(queued);
      }
    },
    [],
  );

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

  const runPdf = useCallback(async () => {
    setBusyPdf(true);
    try {
      await persist();
      // 노트에는 근무 보고서를 그대로 담아 두는 길이 있다(학습 탭의 '노트로').
      // 보고서에는 태움 근거로 쓰인 **문장이 통째로** 들어 있어서, 안 가리고
      // 내보내면 환자·동료 실명이 카카오톡이나 메일로 그대로 나간다.
      const red = await redactForExport(body);
      const ok = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "PDF 로 내보낼까요",
          `${red.summary}\n\n음성과 달리 글은 가릴 수 있어요. 그래도 남는 것은 확인해 주세요.`,
          [
            { text: "취소", style: "cancel", onPress: () => resolve(false) },
            { text: "내보내기", onPress: () => resolve(true) },
          ],
        );
      });
      if (!ok) return;
      await exportNotePdf(title, red.text);
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

      {/* 태그 — 본문에서 뽑은 것 */}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ flex: 1 }} />
        {tags.slice(0, 3).map((tag) => (
          <Text key={tag} style={[type.small, { color: t.accent, alignSelf: "center" }]}>
            {tag}
          </Text>
        ))}
      </View>

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
        handlers={{
          onLink: (target) => void openLink(target),
          onTag: (tag) => router.push({ pathname: "/notes", params: { q: tag } }),
        }}
        placeholder={
          "여기를 눌러 적어요.\n\n## 제목\n- 목록\n- [ ] 할 일\n| 표 | 도 |\n[[다른 노트]] 로 연결, #태그 로 분류"
        }
      />
      <Small>줄을 누르면 그 줄만 열려요. 나머지는 모양 그대로예요.</Small>

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
