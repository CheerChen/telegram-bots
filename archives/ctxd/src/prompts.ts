import type { SessionSource } from "./cache.ts";
import type { SourceType } from "./url.ts";

// ===========================================================================
// Legacy single-turn prompts (Telegram flow — unchanged)
// ===========================================================================

export type ContextAction = "summary" | "translate" | "draft";

interface PromptInput {
  url: string;
  sourceType: SourceType;
  markdown: string;
  truncated: boolean;
}

const ACTION_LABELS: Record<ContextAction, string> = {
  summary: "总结",
  translate: "翻译",
  draft: "起草回复",
};

const SYSTEM_PROMPT = `你是一个给工程师使用的工作消息助手。用户在手机上阅读 Slack 等工作上下文，需要快速理解、翻译或起草回复。

严格遵守当前动作的输出语言和格式。不要做深度 review，不要展开未给出的链接，不要假设自己读过未展开内容。`;

function contextHeader(input: PromptInput): string {
  const note = input.truncated
    ? "\n注意：内容过长，以下只包含前半部分；不要假设缺失部分。"
    : "";
  return `来源类型：${input.sourceType}
URL：${input.url}${note}

工作消息：
<<<
${input.markdown}
>>>`;
}

function summaryPrompt(input: PromptInput): string {
  return `${SYSTEM_PROMPT}

动作：${ACTION_LABELS.summary}
输出语言：简体中文。

语言硬性要求：
- 最终回答中的所有自然语言都必须是简体中文。
- 源文里的日语、英语句子和短语必须翻译成中文后再总结。
- 只允许 URL、PR 编号、Jira key、代码、日志、人名、团队名、产品名等实体保留原文。
- 人名、团队名、产品名可以保留原文，但它们周围的句子必须是中文。
- 不要输出日语助词、日语短语或中日混杂句子。

目标：
帮助用户在手机上快速判断：
- 这是什么事
- 我是否需要行动
- 下一步是什么

请基于以下工作消息，输出极短总结。用户在手机上阅读，目标是判断是否需要行动。

固定格式：

要点：
- 最多 5 条

我是否需要行动：
- 需要 / 不需要 / 不确定（三选一，只写中文）
- 理由一句中文

如果要行动：
- 下一步一句中文

约束：
- 不要做深度分析
- 不要展开代码、日志、URL
- 如果内容里有 PR/Jira/Canvas/Confluence 等链接但没有展开，明确说“相关链接未展开”
- 不要假设自己读过未展开链接
- 不要过度承诺
- 如果上下文不充分，标记为“不确定”
- 如果源文主要是日语，也必须先理解后用中文概括，不要复制日语原句

${contextHeader(input)}`;
}

function translatePrompt(input: PromptInput): string {
  return `${SYSTEM_PROMPT}

动作：${ACTION_LABELS.translate}
输出语言：中文。

请将以下工作消息翻译成中文。

约束：
- 保留 URL
- 保留 PR 编号
- 保留 Jira key
- 保留代码
- 保留日志
- 保留人名
- 保留时间
- 代码、日志、长引用不要逐行翻译，只给简短说明
- 保持原本段落结构
- 不要额外做 review
- 不要展开未给出的链接

${contextHeader(input)}`;
}

function draftPrompt(input: PromptInput): string {
  return `${SYSTEM_PROMPT}

动作：${ACTION_LABELS.draft}
输出语言：日语。

请基于以下工作消息，起草可直接发送的日语回复。

固定输出 3 个版本：

短め：
...

丁寧：
...

確認質問：
...

约束：
- 不要过度承诺
- 不要假装已经处理未处理事项
- 不要自行决定流程走向（如关闭工单、合并、部署到下一环境），除非上下文中明确指出了下一步
- 如果下一步不明确，回复应该只确认已完成的部分
- 环境名（lab/inte/staging/prod）、版本号、ticket 编号等关键标识必须准确保留，不能省略
- 如果上下文显示当前无需行动，回复应表达”承知しました””必要であれば対応します”
- 如果上下文不明确，优先起草确认问题
- 回复要自然，适合公司 Slack
- 不要写太长
- 不要加入中文解释

${contextHeader(input)}`;
}

export function buildActionPrompt(action: ContextAction, input: PromptInput): string {
  switch (action) {
    case "summary":
      return summaryPrompt(input);
    case "translate":
      return translatePrompt(input);
    case "draft":
      return draftPrompt(input);
  }
}

// ===========================================================================
// Multi-turn session prompts (ilink flow)
// ===========================================================================

/**
 * Build the system prompt for a multi-turn session.
 * Called on session creation and whenever sources[] changes.
 */
export function buildSessionSystemPrompt(sources: SessionSource[]): string {
  const sourcesBlock = sources
    .map((s, i) => {
      const label = sources.length > 1 ? `\n--- Source ${i + 1}: ${s.url} ---\n` : "";
      return `${label}${s.markdown}`;
    })
    .join("\n\n");

  return `你是一个给工程师使用的工作消息助手。用户在手机上阅读工作消息（Slack 等），需要你帮助理解、翻译或起草回复。

核心规则：
- 输出语言默认简体中文，除非用户明确要求其他语言
- 源文里的日语、英语必须翻译成中文后再输出（URL、PR 编号、Jira key、代码、日志、人名、团队名、产品名保留原文）
- 不要做深度 review，不要展开未给出的链接，不要假设自己读过未展开内容
- 如果有多个来源，注意区分和关联
- 回答要简洁，用户在手机上阅读

回答格式规则：
- 第一次总结会有专门的格式指令，严格遵守
- 后续追问时，不要套用之前的固定格式，用自然的对话方式直接回答问题
- 追问回答同样要简洁，不需要"要点""是否需要行动"等固定结构

起草回复规则：
- 起草的回复只能基于上下文中明确存在的事实，不要假设用户已完成未提及的操作
- 不要自行决定流程走向（如关闭工单、合并、部署到下一环境），除非上下文中明确指出了下一步。错误示例：上下文只说"lab完成"→ 回复里写"本件クローズでお願いします"
- 如果下一步不明确，回复应该只确认已完成的部分，用「次のステップについてご指示ください」等留白让用户补充
- 环境名（lab/inte/staging/prod）、版本号、ticket 编号等关键标识必须准确保留在回复中，不能省略
- 参考多个来源时，确保从每个来源引用的事实准确且完整

以下是用户提供的工作消息上下文：

<<<
${sourcesBlock}
>>>`;
}

/**
 * The initial summary instruction appended as the first user turn.
 */
export const INITIAL_SUMMARY_INSTRUCTION = `请基于上述工作消息，输出极短总结。用户在手机上阅读，目标是判断是否需要行动。

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
- 如果内容里有 PR/Jira/Canvas/Confluence 等链接但没有展开，明确说"相关链接未展开"
- 不要假设自己读过未展开链接
- 如果上下文不充分，标记为"不确定"`;

/**
 * Instruction used when a new source is appended to an existing session.
 */
export const APPEND_SOURCE_INSTRUCTION = "我补充了新的上下文来源。请基于所有来源重新生成总结（同样格式）。";

/**
 * Shortcut expansion map. Keys are user input, values are the text
 * appended to messages[] as a user turn. LLM never sees the shortcut number.
 */
export const SHORTCUT_MAP: Record<string, string> = {
  "1": "请更详细地分析这个讨论，包括各方观点、未解决的分歧和时间线。",
  "2": "请将上述对话内容翻译为中文。保留 URL、PR 编号、Jira key、代码、日志、人名。代码和日志不要逐行翻译，只给简短说明。",
  "3": "请帮我起草一个日语回复。要求：只基于上下文中的事实，不要假设我已完成未提及的操作，不要自行决定下一步（如关闭工单），环境名和 ticket 编号必须准确保留。回复要自然，适合公司 Slack。",
};

/** Shortcut labels shown in disambiguation. */
const SHORTCUT_LABELS: Record<string, string> = {
  "1": "展开详情",
  "2": "翻译全文",
  "3": "起草回复",
};

/**
 * Build a disambiguation prompt when user triggers a shortcut with multiple sources.
 * Guides user to send natural language like "翻译来源1".
 */
export function buildSourceDisambiguation(
  shortcut: string,
  sources: SessionSource[],
): string {
  const label = SHORTCUT_LABELS[shortcut] ?? shortcut;
  const list = sources
    .map((s, i) => `来源${i + 1}: ${s.sourceType} — ${s.url}`)
    .join("\n");
  return `当前有多个来源：\n\n${list}\n\n请指定来源，例如「${label}来源1」。`;
}

export const MENU_TEXT = "还需要我做什么？\n1 展开详情  2 翻译全文  3 起草回复  0 重置\n或直接输入任何问题";
