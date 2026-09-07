/**
 * 미니 마크다운 렌더러 — 노트·근무 보고서를 그리는 자리.
 *
 * 라이브러리를 안 쓴다: 필요한 것은 옵시디언식 부분집합(제목·목록·체크박스·
 * 콜아웃·표·굵게·코드·[[위키링크]]·#태그)뿐이고, RN 마크다운 라이브러리들은
 * 이 중 위키링크·태그·콜아웃을 어차피 모른다. 직접 그리는 쪽이 짧다.
 *
 * 편집기(markdown-editor)가 블록마다 이 렌더러를 부른다 — 커서가 없는 블록은
 * 여기서 완성된 모양으로 그려진다. 그래서 `text` 는 노트 전체일 수도, 블록
 * 하나일 수도 있다.
 */
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { parseTable, type ParsedTable } from "@nsr/core";
import { radius, space, type, useTheme, type Theme } from "../theme";

export interface MarkdownHandlers {
  /** [[제목]] 을 눌렀을 때. 없으면 링크가 일반 글자로 보인다. */
  onLink?: (title: string) => void;
  /** #태그 를 눌렀을 때. */
  onTag?: (tag: string) => void;
  /** 체크박스를 눌렀을 때. line 은 0-기준 줄 번호, next 는 바뀔 상태. */
  onToggleTask?: (line: number, next: boolean) => void;
}

/** 인라인 문법: **굵게** *기울임* `코드` [[링크|별칭]] #태그 */
function renderInline(text: string, t: Theme, h: MarkdownHandlers, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[\[[^\]\n]+\]\]|#[\p{L}\p{N}/_-]+)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}:${i++}`;
    if (tok.startsWith("**")) {
      out.push(
        <Text key={key} style={{ fontWeight: "700" }}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <Text
          key={key}
          style={{ fontFamily: "monospace", backgroundColor: t.surfaceAlt, color: t.text }}
        >
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith("[[")) {
      const inner = tok.slice(2, -2);
      const [target, alias] = inner.split("|");
      out.push(
        <Text
          key={key}
          style={{ color: t.accent, fontWeight: "600" }}
          onPress={h.onLink ? () => h.onLink?.(target.trim()) : undefined}
        >
          {alias?.trim() || target.trim()}
        </Text>,
      );
    } else if (tok.startsWith("#")) {
      out.push(
        <Text
          key={key}
          style={{ color: t.accent }}
          onPress={h.onTag ? () => h.onTag?.(tok) : undefined}
        >
          {tok}
        </Text>,
      );
    } else {
      // *기울임* — RN 안드로이드 한글 이탤릭은 합성 기울임이라 과하지 않다.
      out.push(
        <Text key={key} style={{ fontStyle: "italic" }}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const CALLOUT: Record<string, { label: string; toneKey: "accent" | "warn" | "danger" | "ok" }> = {
  note: { label: "노트", toneKey: "accent" },
  info: { label: "참고", toneKey: "accent" },
  tip: { label: "팁", toneKey: "ok" },
  warning: { label: "주의", toneKey: "warn" },
  danger: { label: "금기", toneKey: "danger" },
  주의: { label: "주의", toneKey: "warn" },
  금기: { label: "금기", toneKey: "danger" },
  팁: { label: "팁", toneKey: "ok" },
};

/**
 * 제목 여섯 단계. 1~3 은 크기로, 4~6 은 굵기와 색으로 갈린다 —
 * 폰 너비에서 여섯 단계를 전부 크기로 벌리면 4단계부터 본문보다 작아진다.
 * (16px 미만은 굵게 — 작은 회색 글씨는 다크에서 안 보인다.)
 */
const HEADING_TYPE = [
  type.title,
  type.heading,
  { fontSize: 16, lineHeight: 22, fontWeight: "700" as const },
  { fontSize: 15, lineHeight: 21, fontWeight: "700" as const },
  { fontSize: 13, lineHeight: 19, fontWeight: "700" as const },
  { fontSize: 12, lineHeight: 18, fontWeight: "700" as const },
] as const;

/** 목록 들여쓰기 — 공백 두 칸이 한 단. 세 단에서 멈춘다(폰 너비). */
function indent(ws: string): number {
  return Math.min(3, Math.floor(ws.length / 2)) * space.lg;
}

/**
 * 칸 너비를 글자 길이로 어림한다. 칸마다 폭이 같아야 줄이 어긋나지 않아서,
 * 열 하나의 가장 긴 칸을 기준으로 잡는다. 한글은 라틴 글자보다 넓다.
 */
function columnWidth(cells: string[]): number {
  let units = 1;
  for (const c of cells) {
    let u = 0;
    for (const ch of c) u += /[\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF\uFF00-\uFF60]/.test(ch) ? 1.7 : 1;
    if (u > units) units = u;
  }
  return Math.max(76, Math.min(240, Math.round(units * 7.5 + 20)));
}

function TableBlock({
  table,
  t,
  handlers,
  k,
}: {
  table: ParsedTable;
  t: Theme;
  handlers: MarkdownHandlers;
  k: string;
}) {
  const widths = table.header.map((h, c) =>
    columnWidth([h, ...table.rows.map((r) => r[c] ?? "")]),
  );
  const cell = (text: string, c: number, head: boolean, rowKey: string) => (
    <View
      key={c}
      style={{
        width: widths[c],
        paddingHorizontal: space.sm,
        paddingVertical: space.sm,
        borderLeftWidth: c === 0 ? 0 : 1,
        borderLeftColor: t.border,
        justifyContent: "center",
      }}
    >
      <Text
        style={[
          type.small,
          {
            color: head ? t.textMuted : t.text,
            fontWeight: head ? "700" : "400",
            textAlign: table.align[c],
          },
        ]}
      >
        {renderInline(text, t, handlers, `${rowKey}:${c}`)}
      </Text>
    </View>
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // 표 안에서 옆으로 밀 때 화면이 같이 스크롤되지 않게.
      nestedScrollEnabled
      style={{ marginVertical: space.xs }}
    >
      <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", backgroundColor: t.surfaceAlt }}>
          {table.header.map((h, c) => cell(h, c, true, `${k}h`))}
        </View>
        {table.rows.map((row, r) => (
          <View
            key={r}
            style={{
              flexDirection: "row",
              borderTopWidth: 1,
              borderTopColor: t.border,
              backgroundColor: r % 2 === 1 ? t.surfaceAlt : "transparent",
            }}
          >
            {row.map((c, ci) => cell(c, ci, false, `${k}r${r}`))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function Markdown({
  text,
  handlers = {},
}: {
  text: string;
  handlers?: MarkdownHandlers;
}) {
  const t = useTheme();
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let inCode = false;
  let codeBuf: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `l${i}`;

    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        blocks.push(
          <View
            key={key}
            style={{ backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}
          >
            <Text style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 19, color: t.text }}>
              {codeBuf.join("\n")}
            </Text>
          </View>,
        );
        codeBuf = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <Text
          key={key}
          style={[
            HEADING_TYPE[level - 1],
            {
              // 4단계부터는 크기가 본문과 같아진다. 그래서 색으로 층을 낸다 —
              // 한 화면에 제목이 여섯 단계나 있으면 크기만으로는 안 갈린다.
              color: level >= 5 ? t.textMuted : t.text,
              marginTop: i === 0 ? 0 : space.sm,
            },
          ]}
        >
          {renderInline(heading[2], t, handlers, key)}
        </Text>,
      );
      continue;
    }

    // 표 — `|` 로 시작하는 줄이 이어지는 동안. 좁은 폰에서는 옆으로 민다.
    if (/^\s*\|/.test(line)) {
      const start = i;
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) i++;
      const raw = lines.slice(start, i + 1).join("\n");
      const table = parseTable(raw);
      if (table) {
        blocks.push(<TableBlock key={key} table={table} t={t} handlers={handlers} k={key} />);
        continue;
      }
      // 구분선이 없어 표가 아니면 원래 자리로 돌려 한 줄씩 글로 그린다.
      i = start;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(
        <View key={key} style={{ height: 1, backgroundColor: t.border, marginVertical: space.xs }} />,
      );
      continue;
    }

    const task = /^(\s*)- \[( |x|X)\] (.*)$/.exec(line);
    if (task) {
      const checked = task[2].toLowerCase() === "x";
      const lineIdx = i;
      blocks.push(
        <Pressable
          key={key}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          disabled={!handlers.onToggleTask}
          onPress={() => handlers.onToggleTask?.(lineIdx, !checked)}
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: space.sm,
            paddingLeft: indent(task[1]),
          }}
        >
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              marginTop: 3,
              borderWidth: 1.5,
              borderColor: checked ? t.accent : t.textMuted,
              backgroundColor: checked ? t.accent : "transparent",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {checked ? (
              <Text style={{ color: "#FFF", fontSize: 12, lineHeight: 14, fontWeight: "700" }}>✓</Text>
            ) : null}
          </View>
          <Text
            style={[
              type.body,
              {
                flex: 1,
                color: checked ? t.textMuted : t.text,
                textDecorationLine: checked ? "line-through" : "none",
              },
            ]}
          >
            {renderInline(task[3], t, handlers, key)}
          </Text>
        </Pressable>,
      );
      continue;
    }

    const callout = /^>\s*\[!([^\]]+)\]\s*(.*)$/.exec(line);
    if (callout) {
      const meta = CALLOUT[callout[1].trim().toLowerCase()] ?? CALLOUT.note;
      const color = t[meta.toneKey];
      // 다음 줄들의 "> " 이어짐도 이 콜아웃에 담는다.
      const body: string[] = callout[2] ? [callout[2]] : [];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]) && !/^>\s*\[!/.test(lines[i + 1])) {
        body.push(lines[i + 1].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <View
          key={key}
          style={{
            borderLeftWidth: 3,
            borderLeftColor: color,
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.md,
            padding: space.md,
            gap: space.xxs,
          }}
        >
          <Text style={[type.caption, { color }]}>{meta.label}</Text>
          {body.map((b, j) => (
            <Text key={j} style={[type.body, { color: t.text }]}>
              {renderInline(b, t, handlers, `${key}c${j}`)}
            </Text>
          ))}
        </View>,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(
        <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: t.border, paddingLeft: space.md }}>
          <Text style={[type.body, { color: t.textMuted }]}>
            {renderInline(quote[1], t, handlers, key)}
          </Text>
        </View>,
      );
      continue;
    }

    const bullet = /^(\s*)[-*+] (.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <View key={key} style={{ flexDirection: "row", gap: space.sm, paddingLeft: indent(bullet[1]) }}>
          <Text style={[type.body, { color: t.textMuted }]}>•</Text>
          <Text style={[type.body, { flex: 1, color: t.text }]}>
            {renderInline(bullet[2], t, handlers, key)}
          </Text>
        </View>,
      );
      continue;
    }

    const numbered = /^(\s*)(\d+)\. (.*)$/.exec(line);
    if (numbered) {
      blocks.push(
        <View key={key} style={{ flexDirection: "row", gap: space.sm, paddingLeft: indent(numbered[1]) }}>
          <Text style={[type.body, { color: t.textMuted, minWidth: 20 }]}>{numbered[2]}.</Text>
          <Text style={[type.body, { flex: 1, color: t.text }]}>
            {renderInline(numbered[3], t, handlers, key)}
          </Text>
        </View>,
      );
      continue;
    }

    if (line.trim().length === 0) {
      blocks.push(<View key={key} style={{ height: space.sm }} />);
      continue;
    }

    blocks.push(
      <Text key={key} style={[type.body, { color: t.text }]}>
        {renderInline(line, t, handlers, key)}
      </Text>,
    );
  }

  return <View style={{ gap: space.xs }}>{blocks}</View>;
}

/** 본문에서 #태그 를 모두 뽑는다 (중복 제거, 등장 순). */
export function extractTags(body: string): string[] {
  const tags: string[] = [];
  for (const m of body.matchAll(/#[\p{L}\p{N}/_-]+/gu)) {
    if (!tags.includes(m[0])) tags.push(m[0]);
  }
  return tags;
}

/** 본문의 [[위키링크]] 대상 제목들. */
export function extractLinks(body: string): string[] {
  const links: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)) {
    const title = m[1].trim();
    if (title && !links.includes(title)) links.push(title);
  }
  return links;
}
