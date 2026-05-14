import { readFileSync } from "node:fs";
import { fetchSlackThread } from "../src/slack.ts";

function loadDevVars(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const vars = loadDevVars(new URL("../.dev.vars", import.meta.url).pathname);
const token = vars.SLACK_USER_TOKEN;
const url = process.argv[2] ?? "https://your-workspace.slack.com/archives/C12345678/p1234567890123456";

const r = await fetchSlackThread(token!, url);

console.log("=== thread size breakdown ===");
const all = [r.rootMessage, ...r.replies];
const bodySum = all.reduce((s, m) => s + m.body.length, 0);
const attachLines = all.flatMap((m) => m.attachments);
const attachSum = attachLines.reduce((s, l) => s + l.length, 0);
const headerSum = all.reduce(
  (s, m) => s + `### [${m.speaker}] ${m.ts}`.length + 4 /* "\n---\n" */,
  0,
);
console.log(`total markdown: ${r.markdown.length} chars`);
console.log(`  - message bodies (need translation): ${bodySum} chars`);
console.log(`  - per-message headers + separators: ~${headerSum} chars`);
console.log(`  - attachment lines (${attachLines.length}): ${attachSum} chars`);
console.log(
  `  - thread title + participants + ## Conversation: ~${r.markdown.length - bodySum - headerSum - attachSum} chars`,
);
const FENCE_RE = /```([\s\S]*?)```/g;
function compressCodeBlocks(text: string): string {
  return text.replace(FENCE_RE, (_match, inner: string) => {
    const lines = inner.split("\n");
    const meaningful = lines.filter((l) => l.trim().length > 0);
    if (meaningful.length <= 2 && inner.length < 200) return _match;
    const first = meaningful[0] ?? "";
    return "```\n" + first + `\n[... ${lines.length - 1} more lines, ${inner.length} chars elided ...]\n` + "```";
  });
}

let totalCompressed = 0;
let compressedSum = 0;
for (const m of all) {
  const before = m.body.length;
  const after = compressCodeBlocks(m.body).length;
  if (after < before) {
    totalCompressed++;
    compressedSum += before - after;
  }
}
console.log(`\n=== code-block compression ===`);
console.log(`messages with code blocks compressed: ${totalCompressed}`);
console.log(`bytes saved from code-block bodies: ${compressedSum}`);
console.log(`bodies after compression: ${bodySum - compressedSum} chars`);
const leanTotal = bodySum - compressedSum + headerSum;
console.log(`\n=== if we send LLM only headers+compressed-bodies (drop attachments + thread meta) ===`);
console.log(`lean payload: ~${leanTotal} chars (vs current ${r.markdown.length}, ${Math.round((1 - leanTotal / r.markdown.length) * 100)}% reduction)`);

console.log(`\n=== big bodies (before/after compression) ===`);
const ranked = [...all]
  .map((m, i) => ({ i, before: m.body.length, after: compressCodeBlocks(m.body).length, speaker: m.speaker, ts: m.ts, body: m.body }))
  .sort((a, b) => b.before - a.before)
  .slice(0, 3);
for (const x of ranked) {
  console.log(`\n[${x.speaker}] ${x.ts}: ${x.before} → ${x.after}`);
  console.log(`first 200 of original:`);
  console.log(x.body.slice(0, 200));
}

console.log(`\nattachment lines:`);
for (const l of attachLines) console.log(`  ${l.slice(0, 120)}${l.length > 120 ? "…" : ""}`);

console.log("\n=== nestedSlackLinks ===");
console.log(JSON.stringify(r.nestedSlackLinks, null, 2));

console.log("\n=== messages with raw URLs ===");
const slackRe = /https?:\/\/[^\s)<>\]]+slack\.com\/[^\s)<>\]]+/gi;
for (const line of r.markdown.split("\n")) {
  if (line.match(slackRe)) console.log(line);
}

console.log("\n=== fetching first nested as sub-source ===");
if (r.nestedSlackLinks[0]) {
  const sub = await fetchSlackThread(token!, r.nestedSlackLinks[0].url);
  console.log(`messages: ${sub.markdown.split("---").length - 1}, chars: ${sub.markdown.length}`);
  console.log(sub.markdown.slice(0, 1500));
}
