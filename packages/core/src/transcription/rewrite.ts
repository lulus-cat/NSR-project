/**
 * 확정된 낱말 교정을 문장에 한 번만 훑어 반영한다.
 *
 * 왜 한 번인가
 * -----------
 * 낱말마다 따로 훑으면 앞 교정의 결과가 뒤 교정에 다시 걸린다.
 * `[포리→폴리, 폴리→유치도뇨관]` 이 "포리" 를 "유치도뇨관" 으로 만든다 —
 * 아무도 그렇게 시키지 않았다. 왼쪽에서 오른쪽으로 한 번만 지나가면, 이미 바꾼
 * 자리는 다시 보지 않는다.
 *
 * 같은 자리에서 여럿이 걸리면 **가장 긴 것**을 고른다. 짧은 것을 먼저 잡으면
 * "폴리" 가 "폴리 카테터" 를 잘라 먹는다.
 */

export interface Rewrite {
  from: string;
  to: string;
  reason?: string;
}

export interface RewriteHit {
  /** 원문에서의 자리. 되돌릴 때 쓴다. */
  at: number;
  from: string;
  to: string;
  reason: string;
}

export interface RewriteResult {
  text: string;
  hits: RewriteHit[];
}

export function rewriteOnce(text: string, items: Rewrite[]): RewriteResult {
  const clean = items
    .filter((c) => c?.from && c?.to && c.from !== c.to)
    // 긴 것부터 본다. 같은 자리에서 겹칠 때 짧은 것이 이기면 안 된다.
    .sort((a, b) => b.from.length - a.from.length);
  if (clean.length === 0) return { text, hits: [] };

  let out = "";
  let i = 0;
  const hits: RewriteHit[] = [];
  while (i < text.length) {
    const found = clean.find((c) => text.startsWith(c.from, i));
    if (!found) {
      out += text[i];
      i += 1;
      continue;
    }
    hits.push({ at: i, from: found.from, to: found.to, reason: found.reason ?? "misheard" });
    out += found.to;
    i += found.from.length;
  }
  return { text: out, hits };
}
