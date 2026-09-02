/**
 * 라이브 마크다운 편집기 — 편집하는 동안에도 문법이 눈에 보인다.
 *
 * 원리: RN TextInput 은 children 으로 스타일 입힌 Text 조각을 받는다.
 * value 대신 하이라이트된 children 을 넘기는, 코드 편집기들이 쓰는 방식이다.
 *
 * 한 가지 절제: 글자 크기는 전부 같게 둔다. 조각마다 크기를 다르게 주면
 * 안드로이드에서 커서가 실제 글자와 어긋난다. 그래서 제목은 크기가 아니라
 * **굵기와 색**으로 구분되고, 진짜 판형(크기·여백)은 '문서' 보기와 PDF 가 맡는다.
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Text,
  TextInput,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import type { ReactNode } from "react";
import { radius, space, useTheme, type Theme } from "../theme";

export interface MarkdownEditorHandle {
  /** 선택 영역을 marker 로 감싼다(** 굵게 등). 선택이 없으면 쌍을 넣고 커서를 가운데로. */
  wrapSelection(marker: string): void;
  /** 커서가 걸친 줄들의 머리를 바꾼다 — 이미 같은 머리면 떼고, 다른 머리면 갈아끼운다. */
  toggleLinePrefix(prefix: string, group?: string[]): void;
  /** 커서 위치에 그대로 끼워 넣는다. */
  insert(snippet: string): void;
}

/** 줄 머리 후보 — toggleLinePrefix 의 기본 교체 대상. */
const LINE_PREFIXES = ["## ", "### ", "- [ ] ", "- [x] ", "- ", "> ", "1. "];

const INLINE_RE =
  /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[\[[^\]\n]+\]\]|#[\p{L}\p{N}/_-]+)/gu;

/** 한 줄을 스타일 조각으로. 마커까지 그대로 보이되 색·굵기만 입힌다. */
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

/** 본문 전체를 하이라이트 조각으로. */
function highlight(text: string, t: Theme): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `l${i}`;
    if (i > 0) out.push("\n");

    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      out.push(
        <Text key={key} style={{ color: t.textMuted }}>
          {line}
        </Text>,
      );
      continue;
    }
    if (inCode) {
      out.push(
        <Text key={key} style={{ color: t.warn }}>
          {line}
        </Text>,
      );
      continue;
    }

    const heading = /^(#{1,3})\s/.exec(line);
    if (heading) {
      out.push(
        <Text key={key} style={{ fontWeight: "700" }}>
          <Text style={{ color: t.accent }}>{heading[1]}</Text>
          {inlineSpans(line.slice(heading[1].length), t, key)}
        </Text>,
      );
      continue;
    }

    const task = /^(\s*- \[( |x|X)\] )(.*)$/.exec(line);
    if (task) {
      const done = task[2].toLowerCase() === "x";
      out.push(
        <Text key={key}>
          <Text style={{ color: done ? t.ok : t.accent, fontWeight: "600" }}>{task[1]}</Text>
          <Text style={done ? { color: t.textMuted, textDecorationLine: "line-through" } : undefined}>
            {inlineSpans(task[3], t, key)}
          </Text>
        </Text>,
      );
      continue;
    }

    const bullet = /^(\s*(?:[-*]|\d+\.) )(.*)$/.exec(line);
    if (bullet) {
      out.push(
        <Text key={key}>
          <Text style={{ color: t.accent, fontWeight: "600" }}>{bullet[1]}</Text>
          {inlineSpans(bullet[2], t, key)}
        </Text>,
      );
      continue;
    }

    if (/^>/.test(line)) {
      out.push(
        <Text key={key} style={{ color: t.textMuted }}>
          {inlineSpans(line, t, key)}
        </Text>,
      );
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      out.push(
        <Text key={key} style={{ color: t.textMuted }}>
          {line}
        </Text>,
      );
      continue;
    }

    out.push(<Text key={key}>{inlineSpans(line, t, key)}</Text>);
  }
  return out;
}

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    minHeight?: number;
  }
>(function MarkdownEditor({ value, onChange, placeholder, minHeight = 320 }, ref) {
  const t = useTheme();
  const selRef = useRef({ start: 0, end: 0 });
  // 도구 버튼이 글자를 만진 직후 한 번만 커서를 지정한다. 계속 지정하면
  // 안드로이드 IME 조합(한글 자모)이 깨진다.
  const [forcedSelection, setForcedSelection] = useState<
    { start: number; end: number } | undefined
  >(undefined);

  const onSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selRef.current = e.nativeEvent.selection;
      if (forcedSelection) setForcedSelection(undefined);
    },
    [forcedSelection],
  );

  const applyEdit = useCallback(
    (next: string, cursor: { start: number; end: number }) => {
      onChange(next);
      selRef.current = cursor;
      setForcedSelection(cursor);
    },
    [onChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      wrapSelection(marker: string) {
        const { start, end } = selRef.current;
        const before = value.slice(0, start);
        const middle = value.slice(start, end);
        const after = value.slice(end);
        // 이미 감싸져 있으면 벗긴다 — 굵게 버튼을 두 번 누르면 원래대로.
        if (middle.startsWith(marker) && middle.endsWith(marker) && middle.length >= marker.length * 2) {
          const inner = middle.slice(marker.length, middle.length - marker.length);
          applyEdit(before + inner + after, { start, end: start + inner.length });
          return;
        }
        const next = before + marker + middle + marker + after;
        applyEdit(next, {
          start: start + marker.length,
          end: end + marker.length,
        });
      },
      toggleLinePrefix(prefix: string, group: string[] = LINE_PREFIXES) {
        const { start, end } = selRef.current;
        const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
        let lineEnd = value.indexOf("\n", end);
        if (lineEnd < 0) lineEnd = value.length;
        const segment = value.slice(lineStart, lineEnd);
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
        const next = value.slice(0, lineStart) + nextSegment + value.slice(lineEnd);
        const delta = nextSegment.length - segment.length;
        applyEdit(next, { start: Math.max(lineStart, start + delta), end: end + delta });
      },
      insert(snippet: string) {
        const { start, end } = selRef.current;
        const next = value.slice(0, start) + snippet + value.slice(end);
        // [[]] 처럼 괄호 쌍이면 커서를 그 안에 둔다.
        const inner = snippet.indexOf("]]");
        const cursor = inner >= 0 ? start + inner : start + snippet.length;
        applyEdit(next, { start: cursor, end: cursor });
      },
    }),
    [applyEdit, value],
  );

  const children = useMemo(() => highlight(value, t), [value, t]);

  return (
    <TextInput
      multiline
      textAlignVertical="top"
      onChangeText={onChange}
      onSelectionChange={onSelectionChange}
      selection={forcedSelection}
      placeholder={placeholder}
      placeholderTextColor={t.textMuted}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        minHeight,
        color: t.text,
        backgroundColor: t.surface,
        borderRadius: radius.lg,
        padding: space.lg,
        fontSize: 15,
        lineHeight: 23,
      }}
    >
      <Text>{children}</Text>
    </TextInput>
  );
});
