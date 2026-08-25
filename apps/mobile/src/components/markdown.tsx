/**
 * 미니 마크다운 렌더러 — 노트 보기 화면용.
 *
 * 라이브러리를 안 쓴다: 필요한 것은 옵시디언식 부분집합(제목·목록·체크박스·
 * 콜아웃·굵게·코드·[[위키링크]]·#태그)뿐이고, RN 마크다운 라이브러리들은
 * 이 중 위키링크·태그·콜아웃을 어차피 모른다. 직접 그리는 쪽이 짧다.
 *
 * 편집은 일반 TextInput 이 맡는다(옵시디언의 라이브 프리뷰는 모바일 RN 에서
 * 비용이 커서 1차는 편집/보기 분리다).
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
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

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const style =
        level === 1 ? type.title : level === 2 ? type.heading : type.cardTitle;
      blocks.push(
        <Text key={key} style={[style, { color: t.text, marginTop: i === 0 ? 0 : space.sm }]}>
          {renderInline(heading[2], t, handlers, key)}
        </Text>,
      );
      continue;
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
          style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}
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

    const bullet = /^(\s*)[-*] (.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <View key={key} style={{ flexDirection: "row", gap: space.sm, paddingLeft: bullet[1].length >= 2 ? space.lg : 0 }}>
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
        <View key={key} style={{ flexDirection: "row", gap: space.sm }}>
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
