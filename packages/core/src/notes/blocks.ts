/**
 * 노트 본문을 **블록**으로 쪼갠다.
 *
 * 왜 필요한가: 앱의 노트 편집기는 큰 메모앱들처럼 블록마다 따로 고친다.
 * 커서가 있는 블록만 글자로 보이고 나머지는 완성된 모양(표·체크박스·콜아웃)으로
 * 그려진다. RN 의 TextInput 은 자식으로 Text 만 받아서, 한 덩어리 입력창
 * 안에서는 표도 체크박스도 그릴 수 없기 때문이다.
 *
 * **불변식: `joinBlocks(splitBlocks(x)) === x`.** 블록은 원본 줄을 그대로 담고,
 * 붙이는 것은 줄바꿈 하나로 잇는 것뿐이다. 여기가 어긋나면 사용자 글이 사라진다.
 */

export type BlockKind =
  | "heading"
  | "list"
  | "table"
  | "code"
  | "quote"
  | "rule"
  | "blank"
  | "para";

export interface Block {
  kind: BlockKind;
  /** 원본 줄 그대로 (줄바꿈으로 이어진 여러 줄일 수 있다). */
  text: string;
}

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s/;
const TABLE = /^\s*\|/;
const QUOTE = /^\s*>/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLANK = /^\s*$/;
const LIST = /^\s*(?:[-*+]|\d+\.)\s/;

/** 이 줄이 새 블록을 여는가 — 본문 묶음을 어디서 끊을지 판단한다. */
function opensBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    TABLE.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    BLANK.test(line) ||
    LIST.test(line)
  );
}

export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;

  const run = (kind: BlockKind, more: (line: string) => boolean) => {
    const start = i++;
    while (i < lines.length && more(lines[i])) i++;
    out.push({ kind, text: lines.slice(start, i).join("\n") });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE.test(line)) {
      // 닫는 울타리까지 한 블록. 안 닫혔으면 끝까지 — 글자를 잃지 않는다.
      const start = i++;
      while (i < lines.length && !FENCE.test(lines[i])) i++;
      if (i < lines.length) i++; // 닫는 줄도 포함
      out.push({ kind: "code", text: lines.slice(start, i).join("\n") });
      continue;
    }
    // 구분선을 목록보다 먼저 본다 — `---` 이 목록으로 새면 표 구분선까지 흔들린다.
    if (RULE.test(line)) {
      out.push({ kind: "rule", text: line });
      i++;
      continue;
    }
    if (BLANK.test(line)) {
      out.push({ kind: "blank", text: line });
      i++;
      continue;
    }
    if (HEADING.test(line)) {
      out.push({ kind: "heading", text: line });
      i++;
      continue;
    }
    if (TABLE.test(line)) {
      run("table", (l) => TABLE.test(l));
      continue;
    }
    if (QUOTE.test(line)) {
      run("quote", (l) => QUOTE.test(l));
      continue;
    }
    if (LIST.test(line)) {
      // 한 항목이 한 블록. 그래야 목록 하나만 눌러 고칠 수 있다.
      out.push({ kind: "list", text: line });
      i++;
      continue;
    }
    run("para", (l) => !opensBlock(l));
  }

  // split("\n") 은 빈 문자열에도 한 칸을 준다. 그 한 칸을 살려야 되돌릴 수 있다.
  if (out.length === 0) out.push({ kind: "blank", text: "" });
  return out;
}

export function joinBlocks(blocks: readonly Block[]): string {
  return blocks.map((b) => b.text).join("\n");
}

export interface ParsedTable {
  header: string[];
  rows: string[][];
  /** 칸별 정렬. `| ---: |` 는 오른쪽, `| :---: |` 는 가운데. */
  align: ("left" | "center" | "right")[];
}

/** `| --- |` 구분선이 둘째 줄에 있어야 표다. 아니면 null. */
export function parseTable(text: string): ParsedTable | null {
  const lines = text.split("\n").filter((l) => TABLE.test(l));
  if (lines.length < 2) return null;

  const cells = (line: string) => {
    const bare = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
    return bare.split("|").map((c) => c.trim());
  };

  const header = cells(lines[0]);
  const sep = cells(lines[1]);
  if (sep.length !== header.length) return null;
  if (!sep.every((c) => /^:?-{1,}:?$/.test(c))) return null;

  const align = sep.map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
  ) as ParsedTable["align"];

  const rows = lines.slice(2).map((l) => {
    const r = cells(l);
    // 칸이 모자라거나 넘쳐도 머리 수에 맞춘다 — 한 줄이 깨져도 표로 보인다.
    while (r.length < header.length) r.push("");
    return r.slice(0, header.length);
  });

  return { header, rows, align };
}
