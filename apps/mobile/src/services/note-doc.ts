/**
 * 노트 → 인쇄용 문서(PDF).
 *
 * 마크다운 부분집합(components/markdown.tsx 와 같은 문법)을 HTML 로 바꿔
 * expo-print 로 PDF 를 만든다. 종이 위 판형은 사용자의 취향을 그대로 박았다:
 * 여백 상하좌우 1.17인치, 줄간은 촘촘하게(1.4) — 문서가 늘어지는 걸 싫어한다.
 *
 * 개인정보: 노트는 사용자가 직접 쓴 글이고 PDF 는 기기 안에서 만들어져
 * 공유 시트로만 나간다 — 서버 전송이 없다.
 */
/** 종이 판형 — 사용자가 고른 기본값. 바꾸려면 여기서. */
export const PAGE = {
  marginInch: 1.17,
  bodyPt: 11,
  lineHeight: 1.4,
} as const;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 인라인 문법: **굵게** *기울임* `코드` [[링크|별칭]] #태그 */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_m, target, alias) =>
      `<span class="link">${(alias || target).trim()}</span>`,
    )
    .replace(/#([\p{L}\p{N}/_-]+)/gu, '<span class="tag">#$1</span>');
}

const CALLOUT_LABEL: Record<string, string> = {
  note: "노트", info: "참고", tip: "팁", warning: "주의", danger: "금기",
  주의: "주의", 금기: "금기", 팁: "팁",
};

/** 마크다운 부분집합 → 본문 HTML. 렌더러(markdown.tsx)와 같은 문법을 본다. */
export function markdownToHtml(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listOpen: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };
  const openList = (kind: "ul" | "ol") => {
    if (listOpen !== kind) {
      closeList();
      out.push(`<${kind}>`);
      listOpen = kind;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      closeList();
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
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
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      out.push("<hr/>");
      continue;
    }

    const task = /^\s*- \[( |x|X)\] (.*)$/.exec(line);
    if (task) {
      openList("ul");
      const checked = task[1].toLowerCase() === "x";
      out.push(
        `<li class="task${checked ? " done" : ""}"><span class="box">${checked ? "☑" : "☐"}</span> ${inline(task[2])}</li>`,
      );
      continue;
    }

    const callout = /^>\s*\[!([^\]]+)\]\s*(.*)$/.exec(line);
    if (callout) {
      closeList();
      const label = CALLOUT_LABEL[callout[1].trim().toLowerCase()] ?? "노트";
      const parts: string[] = callout[2] ? [inline(callout[2])] : [];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]) && !/^>\s*\[!/.test(lines[i + 1])) {
        parts.push(inline(lines[i + 1].replace(/^>\s?/, "")));
        i++;
      }
      out.push(
        `<div class="callout"><div class="callout-label">${esc(label)}</div>${parts.map((p) => `<p>${p}</p>`).join("")}</div>`,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*] (.*)$/.exec(line);
    if (bullet) {
      openList("ul");
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = /^\s*\d+\. (.*)$/.exec(line);
    if (numbered) {
      openList("ol");
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    if (line.trim().length === 0) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode && codeBuf.length > 0) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}

/** 문서 전체 HTML — A4, 여백 1.17in, 줄간 1.4. */
export function noteHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4; margin: ${PAGE.marginInch}in; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Noto Sans KR", "Malgun Gothic", sans-serif;
    font-size: ${PAGE.bodyPt}pt;
    line-height: ${PAGE.lineHeight};
    color: #1a1a1a;
    word-break: keep-all;
  }
  h1 { font-size: 17pt; margin: 0 0 6pt; line-height: 1.3; }
  h2 { font-size: 14pt; margin: 10pt 0 3pt; line-height: 1.3; }
  h3 { font-size: 12pt; margin: 8pt 0 2pt; line-height: 1.3; }
  p { margin: 0 0 3pt; }
  ul, ol { margin: 0 0 3pt; padding-left: 16pt; }
  li { margin: 0 0 1pt; }
  li.task { list-style: none; margin-left: -14pt; }
  li.task .box { font-size: ${PAGE.bodyPt + 1}pt; }
  li.task.done { color: #777; text-decoration: line-through; }
  blockquote { margin: 2pt 0 3pt; padding: 0 0 0 8pt; border-left: 2pt solid #bbb; color: #555; }
  .callout { border-left: 2.5pt solid #2f6b58; background: #f2f6f4; padding: 5pt 8pt; margin: 3pt 0; }
  .callout-label { font-weight: 700; font-size: ${PAGE.bodyPt - 1.5}pt; color: #2f6b58; margin-bottom: 1pt; }
  .callout p { margin: 0; }
  code { font-family: "Courier New", monospace; font-size: ${PAGE.bodyPt - 1}pt; background: #f1f1f1; padding: 0 2pt; }
  pre { background: #f1f1f1; padding: 6pt; margin: 3pt 0; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 0.75pt solid #ccc; margin: 6pt 0; }
  .link { color: #2f6b58; font-weight: 600; }
  .tag { color: #2f6b58; }
  .doc-title { font-size: 19pt; font-weight: 700; line-height: 1.25; margin: 0 0 10pt; }
</style>
</head>
<body>
${title.trim() ? `<div class="doc-title">${esc(title)}</div>` : ""}
${markdownToHtml(body)}
</body>
</html>`;
}

/** 노트를 PDF 로 만들어 공유 시트를 연다. */
export async function exportNotePdf(title: string, body: string): Promise<void> {
  const Print = await import("expo-print");
  const Sharing = await import("expo-sharing");
  const { uri } = await Print.printToFileAsync({ html: noteHtml(title, body) });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("앗 이 폰에선 공유 창을 못 열어요 ㅠㅠ");
  }
  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    dialogTitle: `${title.trim() || "이름 없는 녀석"} PDF로 예쁘게 굽기`,
  });
}
