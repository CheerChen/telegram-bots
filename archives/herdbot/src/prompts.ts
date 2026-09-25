import { readFile } from "node:fs/promises";

import type { HerdConfig } from "./config.ts";

/**
 * Base system prompt for the agent loop.
 *
 * Company-specific details (internal terms, project names, workflow habits)
 * are intentionally absent here — they live in herdbot.local.md on the Pi,
 * loaded by loadLocalPrompt() and prepended at runtime.
 */
const BASE_SYSTEM_PROMPT = `You are herdbot, a work-context assistant for an engineer reading messages on a phone via Telegram.

You have one tool: \`ctxd <url>\`, which fetches a GitHub PR, Slack thread, Confluence page, or Jira issue and returns dense Markdown. Use it whenever the user sends a URL or asks you to look at a link you haven't fetched yet.

Output rules:
- Default output language is Simplified Chinese unless the user explicitly asks for another language.
- Japanese and English source text must be translated to Chinese before summarizing. URLs, PR numbers, Jira keys, code, logs, person/team/product names stay in the original.
- Keep answers concise — the user is on a phone.
- Do not deep-review. Do not expand links that were not fetched. Do not assume you read content you did not fetch.
- When drafting a reply in Japanese, base it only on facts present in the fetched context. Do not assume actions were taken unless stated. Do not decide process steps (closing tickets, merging, deploying) unless the context explicitly indicates the next step. Environment names (lab/inte/staging/prod), version numbers, and ticket IDs must be preserved exactly.

Session rules:
- The user can send multiple URLs across turns; each new URL is fetched and added to the conversation.
- If the user asks a follow-up question, answer directly in natural conversational style — do not reuse the fixed summary format after the first summary.`;

/**
 * Initial summary instruction — used as the first user turn when a URL
 * arrives and no session is active yet. Mirrors the ctxd-bot format so
 * the output stays scannable on a phone.
 */
export const INITIAL_SUMMARY_INSTRUCTION = `请先用 ctxd 抓取上面的链接，再基于抓取到的内容输出极短总结。用户在手机上阅读，目标是判断是否需要行动。

固定格式：

要点：
- 最多 5 条

我是否需要行动：
- 需要 / 不需要 / 不确定（三选一）
- 理由一句话

如果要行动：
- 下一步一句话

约束：
- 不要做深度分析
- 不要展开代码、日志、URL
- 如果内容里有 PR/Jira/Confluence 等链接但没有展开，明确说"相关链接未展开"
- 不要假设自己读过未展开链接
- 如果上下文不充分，标记为"不确定"`;

/**
 * Load the gitignored local prompt overlay if it exists.
 * Returns empty string if the file is absent — the agent runs with the
 * base prompt only. Never throws on missing file.
 */
export async function loadLocalPrompt(config: HerdConfig): Promise<string> {
  try {
    const content = await readFile(config.localPromptPath, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

/**
 * Load an external skill doc (e.g. ctxd SKILL.md) to embed in the system
 * prompt. The file is mounted via compose, not hardcoded in source.
 */
async function loadSkillDoc(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    // Strip YAML frontmatter — the agent doesn't need the metadata block.
    return content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  } catch {
    return "";
  }
}

/**
 * Assemble the full system prompt: base + skill docs + optional local overlay.
 */
export async function buildSystemPrompt(config: HerdConfig): Promise<string> {
  const skillDoc = await loadSkillDoc(config.ctxdSkillPath);
  const local = await loadLocalPrompt(config);

  const parts = [BASE_SYSTEM_PROMPT];

  if (skillDoc) {
    parts.push(`---
# ctxd usage reference (loaded from ${config.ctxdSkillPath})
${skillDoc}`);
  }

  if (local) {
    parts.push(`---
# Local context (herdbot.local.md — not in source control)
${local}`);
  }

  return parts.join("\n\n");
}
