/**
 * 티로 노트 문단 → 가려진 문장. 서버(파이썬)가 이 스크립트를 부른다.
 *
 * 왜 노드로 부르나
 * ---------------
 * 가리기(`deidentify`)와 문단 펴기(`tiroParagraphsToSegments`)는 이미
 * `packages/core` 에 있고 테스트가 붙어 있다. 파이썬으로 다시 짜면 구현이 두 벌이
 * 되고, 두 벌은 반드시 어긋난다. 그래서 서버는 이 스크립트를 한 번 부르고 만다.
 *
 * 쓰는 법
 *   echo '{"paragraphs":[...],"baseMs":0}' | node tools/mask-tiro-note.mjs
 *   → {"segments":[{startSec,endSec,text,speakerId}],"locked":n,"redacted":n}
 *
 * 못 가리는 것: 호칭 없이 부르는 이름("영희야"). 폰에는 사용자가 등록한 이름
 * 목록(extraTerms)이 있어 그것까지 가리지만, 서버에는 그 목록이 없다.
 * ponytail: 서버 경로는 그만큼 약하다. 필요해지면 폰이 그 목록을 올리게 한다.
 */
import { deidentify, tiroParagraphsToSegments } from "@nsr/core";

const input = JSON.parse(await new Response(process.stdin).text());
const { segments, locked } = tiroParagraphsToSegments(input.paragraphs ?? [], input.baseMs ?? 0);

let redacted = 0;
const out = [];
for (const s of segments) {
  // 기본값은 병실(location)을 안 가린다 — 서버로 나가는 길에서는 그것도 가린다.
  const r = deidentify(s.text, { disable: [] });
  redacted += r.redactions.length;
  if (r.text.trim()) out.push({ ...s, text: r.text });
}

process.stdout.write(JSON.stringify({ segments: out, locked, redacted }));
