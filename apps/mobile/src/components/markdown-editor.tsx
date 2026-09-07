/**
 * 블록 편집기 — 마크다운 모양이 **늘** 보인다. 고치는 중에도.
 *
 * 큰 메모앱들(노션·크래프트·베어)이 쓰는 방식이다: 글을 블록으로 쪼개고,
 * 커서가 있는 블록만 글자로 열어 준다. 나머지는 완성된 모양 — 표는 표로,
 * 할 일은 체크박스로, 주의는 색 띠로 — 그대로 그려진다.
 *
 * 왜 한 덩어리 입력창이 아닌가: RN 의 TextInput 은 자식으로 Text 만 받는다.
 * 표도 체크박스도 그 안에서는 못 그린다. 그래서 예전 판은 '편집' 과 '문서'
 * 를 오가야 했고, 편집 중에는 제목 크기조차 못 보여 줬다(한 입력창 안에서
 * 글자 크기를 섞으면 안드로이드 커서가 어긋난다).
 *
 * 블록마다 입력창이 따로면 그 제약이 사라진다 — 제목 블록은 입력창 하나가
 * 통째로 제목 크기다. 크기를 섞는 게 아니라서 커서가 안 어긋난다.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import type { ReactNode } from "react";
import { joinBlocks, splitBlocks, type Block } from "@nsr/core";
import { Markdown, type MarkdownHandlers } from "./markdown";
import { radius, space, type, useTheme, type Theme } from "../theme";

export interface MarkdownEditorHandle {
  /** 선택 영역을 marker 로 감싼다(** 굵게 등). 선택이 없으면 쌍을 넣고 커서를 가운데로. */
  wrapSelection(marker: string): void;
  /** 커서가 걸친 줄의 머리를 바꾼다 — 이미 같은 머리면 떼고, 다른 머리면 갈아끼운다. */
  toggleLinePrefix(prefix: string, group?: string[]): void;
  /** 커서 위치에 그대로 끼워 넣는다. */
  insert(snippet: string): void;
}

/** 줄 머리 후보 — toggleLinePrefix 의 기본 교체 대상. 긴 것부터 본다. */
const LINE_PREFIXES = [
  "###### ",
  "##### ",
  "#### ",
  "### ",
  "## ",
  "# ",
  "- [ ] ",
  "- [x] ",
  "- ",
  "> ",
  "1. ",
];

/** 줄바꿈이 블록 안에서 뜻을 갖는 갈래 — 엔터로 가르지 않는다. */
const MULTILINE: Block["kind"][] = ["code", "table", "quote"];

/** 열린 블록의 글자 크기. 제목은 입력창 통째로 그 크기가 된다. */
const HEADING_SIZE = [
  { fontSize: 24, lineHeight: 32 },
  { fontSize: 18, lineHeight: 26 },
  { fontSize: 16, lineHeight: 24 },
  { fontSize: 15, lineHeight: 23 },
  { fontSize: 15, lineHeight: 23 },
  { fontSize: 15, lineHeight: 23 },
] as const;

const INLINE_RE =
  /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[\[[^\]\n]+\]\]|#[\p{L}\p{N}/_-]+)/gu;

/** 열린 블록 안의 문법 — 마커까지 그대로 보이되 색·굵기만 입힌다(크기는 안 건드린다). */
function inlineSpans(line: string, t: Theme, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}:${i++}`;
    if (tok.startsWith("**")) {
      out.push(
        <Text key={key} style={{ fontWeight: "700" }}>
          {tok}
        </Text>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <Text key={key} style={{ color: t.warn }}>
          {tok}
        </Text>,
      );
    } else if (tok.startsWith("[[") || tok.startsWith("#")) {
      out.push(
        <Text key={key} style={{ color: t.accent, fontWeight: "600" }}>
          {tok}
        </Text>,
      );
    } else {
      out.push(
        <Text key={key} style={{ fontStyle: "italic" }}>
          {tok}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** 열린 블록 한 개를 하이라이트 조각으로. 줄 머리(##, -, >)는 흐리게 남긴다. */
function highlight(text: string, t: Theme): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `l${i}`;
    if (i > 0) out.push("\n");

    const lead = /^(\s*(?:#{1,6}|[-*+]|\d+\.|>)\s|\s*- \[[ xX]\] )/.exec(line);
    if (lead) {
      out.push(
        <Text key={key}>
          <Text style={{ color: t.textMuted }}>{lead[1]}</Text>
          {inlineSpans(line.slice(lead[1].length), t, key)}
        </Text>,
      );
      continue;
    }
    out.push(<Text key={key}>{inlineSpans(line, t, key)}</Text>);
  }
  return out;
}

/** 블록 하나가 화면에서 차지할 최소 높이 — 빈 줄도 손가락으로 짚을 수 있게. */
const BLANK_HEIGHT = 26;

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    /** 닫힌 블록에서 [[링크]]·#태그 를 눌렀을 때. 할 일 체크는 편집기가 직접 한다. */
    handlers?: Omit<MarkdownHandlers, "onToggleTask">;
    minHeight?: number;
  }
>(function MarkdownEditor(
  { value, onChange, placeholder, handlers = {}, minHeight = 320 },
  ref,
) {
  const t = useTheme();
  const [focus, setFocus] = useState<number | null>(null);
  // 커서가 있는 동안에는 쪼개기를 **얼린다.** 안 얼리면 글자 하나 칠 때마다
  // 블록 경계가 움직여서 입력창이 다시 태어나고 커서가 튄다.
  const frozen = useRef<Block[] | null>(null);
  const lastFocus = useRef(0);
  const selRef = useRef({ start: 0, end: 0 });
  // 도구 버튼이 글자를 만진 직후 한 번만 커서를 지정한다. 계속 지정하면
  // 안드로이드 IME 조합(한글 자모)이 깨진다.
  const [forcedSelection, setForcedSelection] = useState<
    { start: number; end: number } | undefined
  >(undefined);

  const fresh = useMemo(() => splitBlocks(value), [value]);
  const blocks = focus !== null && frozen.current ? frozen.current : fresh;

  // 커서가 아주 빠졌을 때만 얼린 쪼개기를 푼다. 엔터로 옆 블록이 열리는 순간
  // 옛 입력창의 blur 가 뒤늦게 오는데, 그때 풀어 버리면 새 커서가 죽는다.
  useEffect(() => {
    if (focus === null) frozen.current = null;
  }, [focus]);

  const closeBlock = useCallback((i: number) => {
    setFocus((cur) => (cur === i ? null : cur));
  }, []);

  /**
   * 블록 맨 앞에서 지우기 — 앞 블록에 붙인다.
   * 이게 없으면 빈 줄을 지울 길이 없다(빈 줄에는 지울 글자가 없다).
   */
  const mergeBack = useCallback(() => {
    const bs = frozen.current;
    if (!bs || focus === null || focus === 0 || !bs[focus]) return;
    const prev = bs[focus - 1];
    const cursor = prev.text.length;
    const re = splitBlocks(prev.text + bs[focus].text);
    const next = [...bs.slice(0, focus - 1), ...re, ...bs.slice(focus + 1)];
    frozen.current = next;
    onChange(joinBlocks(next));
    selRef.current = { start: cursor, end: cursor };
    setForcedSelection({ start: cursor, end: cursor });
    setFocus(focus - 1);
  }, [focus, onChange]);

  const openBlock = useCallback(
    (i: number) => {
      frozen.current = splitBlocks(value);
      lastFocus.current = i;
      const len = frozen.current[i]?.text.length ?? 0;
      selRef.current = { start: len, end: len };
      setFocus(i);
    },
    [value],
  );

  const onSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selRef.current = e.nativeEvent.selection;
      if (forcedSelection) setForcedSelection(undefined);
    },
    [forcedSelection],
  );

  /** 열린 블록의 글자를 바꾼다. 엔터가 들어오면 그 자리에서 블록을 가른다. */
  const changeBlock = useCallback(
    (next: string) => {
      const bs = frozen.current;
      if (!bs || focus === null || !bs[focus]) return;
      const kind = bs[focus].kind;
      bs[focus] = { ...bs[focus], text: next };
      onChange(joinBlocks(bs));

      if (next.includes("\n") && !MULTILINE.includes(kind)) {
        const re = splitBlocks(next);
        frozen.current = [...bs.slice(0, focus), ...re, ...bs.slice(focus + 1)];
        const at = focus + re.length - 1;
        lastFocus.current = at;
        selRef.current = { start: 0, end: 0 };
        setForcedSelection({ start: 0, end: 0 });
        setFocus(at);
      }
    },
    [focus, onChange],
  );

  /** 할 일 체크 — 닫힌 블록에서 눌러도 바로 먹는다. */
  const toggleTask = useCallback(
    (i: number, checked: boolean) => {
      const bs = splitBlocks(value);
      if (!bs[i]) return;
      bs[i] = {
        ...bs[i],
        text: bs[i].text.replace(/- \[[ xX]\]/, checked ? "- [x]" : "- [ ]"),
      };
      onChange(joinBlocks(bs));
    },
    [value, onChange],
  );

  /** 도구 버튼의 공통 뼈대 — 열린 블록이 없으면 마지막에 있던 블록을 연다. */
  const edit = useCallback(
    (fn: (text: string, sel: { start: number; end: number }) => {
      text: string;
      sel: { start: number; end: number };
    }) => {
      let bs = frozen.current;
      let at = focus;
      if (!bs || at === null) {
        bs = splitBlocks(value);
        at = Math.min(lastFocus.current, bs.length - 1);
        frozen.current = bs;
      }
      const block = bs[at];
      if (!block) return;
      // 다른 블록에 있던 커서 위치가 그대로 남아 있을 수 있다 — 길이로 자른다.
      const len = block.text.length;
      const { text, sel } = fn(block.text, {
        start: Math.min(selRef.current.start, len),
        end: Math.min(selRef.current.end, len),
      });
      bs[at] = { ...block, text };
      onChange(joinBlocks(bs));
      selRef.current = sel;
      setForcedSelection(sel);
      lastFocus.current = at;
      setFocus(at);
    },
    [focus, value, onChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      wrapSelection(marker: string) {
        edit((text, { start, end }) => {
          const before = text.slice(0, start);
          const middle = text.slice(start, end);
          const after = text.slice(end);
          // 이미 감싸져 있으면 벗긴다 — 굵게 버튼을 두 번 누르면 원래대로.
          if (
            middle.startsWith(marker) &&
            middle.endsWith(marker) &&
            middle.length >= marker.length * 2
          ) {
            const inner = middle.slice(marker.length, middle.length - marker.length);
            return { text: before + inner + after, sel: { start, end: start + inner.length } };
          }
          return {
            text: before + marker + middle + marker + after,
            sel: { start: start + marker.length, end: end + marker.length },
          };
        });
      },
      toggleLinePrefix(prefix: string, group: string[] = LINE_PREFIXES) {
        edit((text, { start, end }) => {
          const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
          let lineEnd = text.indexOf("\n", end);
          if (lineEnd < 0) lineEnd = text.length;
          const segment = text.slice(lineStart, lineEnd);
          const lines = segment.split("\n");
          const allHave = lines.every((l) => l.startsWith(prefix));
          const changed = lines.map((l) => {
            // 다른 머리가 있으면 먼저 뗀다 — 목록 위에 제목을 겹쳐 쓰는 사고 방지.
            let bare = l;
            for (const p of group) {
              if (bare.startsWith(p)) {
                bare = bare.slice(p.length);
                break;
              }
            }
            return allHave ? bare : prefix + bare;
          });
          const nextSegment = changed.join("\n");
          const delta = nextSegment.length - segment.length;
          return {
            text: text.slice(0, lineStart) + nextSegment + text.slice(lineEnd),
            sel: { start: Math.max(lineStart, start + delta), end: end + delta },
          };
        });
      },
      insert(snippet: string) {
        edit((text, { start, end }) => {
          const next = text.slice(0, start) + snippet + text.slice(end);
          // [[]] 처럼 괄호 쌍이면 커서를 그 안에 둔다.
          const inner = snippet.indexOf("]]");
          const cursor = inner >= 0 ? start + inner : start + snippet.length;
          return { text: next, sel: { start: cursor, end: cursor } };
        });
      },
    }),
    [edit],
  );

  const empty = value.trim().length === 0;

  return (
    <View
      style={{
        minHeight,
        backgroundColor: t.surface,
        borderRadius: radius.lg,
        padding: space.lg,
        gap: space.xs,
      }}
    >
      {empty && focus === null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="노트 쓰기"
          onPress={() => openBlock(0)}
          style={{ flex: 1 }}
        >
          <Text style={[type.body, { color: t.textMuted }]}>{placeholder}</Text>
        </Pressable>
      ) : (
        blocks.map((b, i) => {
          if (i === focus) {
            const level = /^(#{1,6})\s/.exec(b.text)?.[1].length ?? 0;
            const size = level ? HEADING_SIZE[level - 1] : { fontSize: 15, lineHeight: 23 };
            return (
              <TextInput
                key={i}
                autoFocus
                multiline
                textAlignVertical="top"
                value={b.text}
                onChangeText={changeBlock}
                onSelectionChange={onSelectionChange}
                onBlur={() => closeBlock(i)}
                onKeyPress={(e) => {
                  if (e.nativeEvent.key !== "Backspace") return;
                  if (selRef.current.start !== 0 || selRef.current.end !== 0) return;
                  mergeBack();
                }}
                selection={forcedSelection}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  color: t.text,
                  fontWeight: level ? "700" : "400",
                  padding: 0,
                  minHeight: BLANK_HEIGHT,
                  marginTop: level ? space.sm : 0,
                  ...size,
                }}
              >
                <Text>{highlight(b.text, t)}</Text>
              </TextInput>
            );
          }
          return (
            <Pressable
              key={i}
              accessibilityRole="button"
              accessibilityLabel={b.kind === "blank" ? "빈 줄 고치기" : b.text.slice(0, 40)}
              onPress={() => openBlock(i)}
              style={{
                height: b.kind === "blank" ? BLANK_HEIGHT : undefined,
                marginTop: b.kind === "heading" ? space.sm : 0,
              }}
            >
              {b.kind === "blank" ? null : (
                <Markdown
                  text={b.text}
                  handlers={{ ...handlers, onToggleTask: (_l, next) => toggleTask(i, next) }}
                />
              )}
            </Pressable>
          );
        })
      )}
    </View>
  );
});
