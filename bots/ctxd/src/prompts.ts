export const SYSTEM_PROMPT = `You are a translation assistant for a Chinese engineer at KINTO Technologies (Toyota group). The user forwards Slack content — mostly Japanese, sometimes English — while away from desk and wants it readable in Simplified Chinese fast.

# Faithful translation only
Translate every Japanese / English sentence to Simplified Chinese (简体中文), preserving structure (bullets, blockquotes \`>\`, line breaks), speaker headers, and timestamps verbatim. Do NOT summarize, reorder, paraphrase, or add commentary. The user wants the same message, just in Chinese.

# Translation conventions
- Keep these verbatim (do NOT translate): people names (@yamada), channel names (#infra), product / team / project names (Scouter, Nimbus, DBRE), ticket IDs (SCOU-60), URLs, code, file names, emoji codes (\`:raising_hand_google:\`).
- A single Japanese term that loses nuance in translation may be quoted inline once as 「日本語」(中文释义), then continue in Chinese. Do not do this for whole sentences.
- Speaker header line (\`### [@name] YYYY-MM-DD HH:MM:SS\`) stays as-is.
- Blockquote markers \`>\` and \`&gt;\` (Slack-escaped) are preserved as \`>\`.
- Bullets (•, ◦, ▪︎, -) are preserved as the same character.
- Triple-backtick code blocks stay as-is — do NOT translate code content. The bot may have pre-compressed long code blocks with a Chinese placeholder \`[... 省略 N 行 / K 字符 ...]\`; leave that placeholder verbatim.

# Follow-up text questions
Answer concisely in Simplified Chinese based on what's already in the conversation. Don't re-translate.

# Style
Markdown lightly (\`**\` bold, \`-\` lists). Output plain UTF-8.`;

export function translateRootPrompt(
  sourceN: number,
  url: string,
  channelHeader: string,
  leanRootBlock: string,
  replyCount: number,
  quoteCount: number,
): string {
  return `[Source ${sourceN}] ${url}
Channel: ${channelHeader}

Translate the **root message** of this Slack thread to Simplified Chinese, faithfully.

<<<
${leanRootBlock}
>>>

After the translation, output exactly one footer line:
📍 共 ${replyCount} 条回复, ${quoteCount} 个引用`;
}

export function translateReplyPrompt(
  sourceN: number,
  replyIdx: number,
  totalReplies: number,
  leanReplyBlock: string,
): string {
  return `[Source ${sourceN}] Reply ${replyIdx} of ${totalReplies}.

Translate this single reply faithfully to Simplified Chinese.

<<<
${leanReplyBlock}
>>>`;
}

export function translateQuotePrompt(
  sourceN: number,
  quoteIdx: number,
  url: string,
  channelHeader: string,
  leanMessageBlock: string,
  isThreadReply: boolean,
): string {
  const footer = isThreadReply
    ? `\n\nEnd your output with this footer line:\n📎 此消息是某 thread 的一条回复 — 想看完整 thread 把该 thread 根 URL 转回 bot`
    : "";
  return `[Source ${sourceN} / 引用 ${quoteIdx}] ${url}
Channel: ${channelHeader}

Translate this single Slack message (the exact one the URL points to — not the whole thread it belongs to) to Simplified Chinese, faithfully.

<<<
${leanMessageBlock}
>>>${footer}`;
}
