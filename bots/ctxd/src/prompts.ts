import type { SourceType } from "./url.ts";

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
- 如果上下文显示当前无需行动，回复应表达“承知しました”“必要であれば対応します”
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
