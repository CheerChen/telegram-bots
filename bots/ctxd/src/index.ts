import { isAllowedChat, verifyWebhookSecret } from "shared/auth";
import { chat, type Message as LlmMessage } from "shared/llm";
import {
  kvSessionStore,
  newSession,
  type Session,
  type SessionSource,
  touch,
} from "shared/session";
import {
  answerCallbackQuery,
  editMessageText,
  escapeHtml,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  sendMessage,
} from "shared/telegram";
import type { CallbackQuery, TelegramUpdate } from "shared/types";
import {
  SYSTEM_PROMPT,
  translateQuotePrompt,
  translateReplyPrompt,
  translateRootPrompt,
} from "./prompts.ts";
import {
  fetchSingleMessage,
  fetchSlackThread,
  isSlackUrl,
  type NestedSlackLink,
  renderLeanBlock,
  type SingleMessageResult,
  type SlackFetchResult,
} from "./slack.ts";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  SLACK_USER_TOKEN: string;
  CTXD_SESSIONS: KVNamespace;
}

type CtxdSource = SessionSource & {
  channelHeader: string;
  rootLean: string;
  replyLeans: string[];
  nestedSlackLinks: NestedSlackLink[];
};

const URL_RE = /https?:\/\/\S+/g;
const TG_MAX_LEN = 3900;
const REPLY_BUTTON_CAP = 10;
const QUOTE_BUTTON_CAP = 10;
const BUTTONS_PER_ROW = 3;
const CALLBACK_RE = /^(r|q):(\d+):(\d+)$/;

function llmToHtml(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return out;
}

function truncate(s: string): string {
  return s.length > TG_MAX_LEN ? `${s.slice(0, TG_MAX_LEN - 15)}\n…(truncated)` : s;
}

function buildLlmMessages(session: Session): LlmMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages];
}

function buildKeyboard(
  sourceN: number,
  replyCount: number,
  quoteCount: number,
): InlineKeyboardMarkup | undefined {
  const rows: InlineKeyboardButton[][] = [];
  const replies = Math.min(replyCount, REPLY_BUTTON_CAP);
  for (let i = 0; i < replies; i += BUTTONS_PER_ROW) {
    const row: InlineKeyboardButton[] = [];
    for (let j = i; j < Math.min(i + BUTTONS_PER_ROW, replies); j++) {
      const idx = j + 1;
      row.push({ text: `翻译 回复${idx}`, callback_data: `r:${sourceN}:${idx}` });
    }
    rows.push(row);
  }
  const quotes = Math.min(quoteCount, QUOTE_BUTTON_CAP);
  for (let i = 0; i < quotes; i += BUTTONS_PER_ROW) {
    const row: InlineKeyboardButton[] = [];
    for (let j = i; j < Math.min(i + BUTTONS_PER_ROW, quotes); j++) {
      const idx = j + 1;
      row.push({ text: `翻译 引用${idx}`, callback_data: `q:${sourceN}:${idx}` });
    }
    rows.push(row);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

function extractFirstUrl(text: string): { url?: string; multiple: boolean } {
  const urls = text.match(URL_RE) ?? [];
  if (urls.length === 0) return { multiple: false };
  if (urls.length > 1) return { multiple: true };
  return { url: urls[0], multiple: false };
}

async function replyPlain(env: Env, chatId: number, text: string): Promise<void> {
  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text,
    parseMode: "HTML",
    disableWebPagePreview: true,
  });
}

async function callLlmAndRender(
  env: Env,
  chatId: number,
  progressId: number,
  session: Session,
  keyboard?: InlineKeyboardMarkup,
): Promise<void> {
  let answer: string;
  try {
    answer = await chat(env, buildLlmMessages(session));
  } catch (e) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: `⚠️ LLM call failed: <code>${escapeHtml(e instanceof Error ? e.message : String(e))}</code>`,
      parseMode: "HTML",
      disableWebPagePreview: true,
    });
    return;
  }
  session.messages.push({ role: "assistant", content: answer });
  await kvSessionStore(env.CTXD_SESSIONS).put(chatId, touch(session));

  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: truncate(llmToHtml(answer)),
    parseMode: "HTML",
    disableWebPagePreview: true,
    replyMarkup: keyboard,
  });
}

async function ingestSlack(env: Env, chatId: number, url: string): Promise<void> {
  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: "⏳ Fetching Slack thread…",
  });

  let fetched: SlackFetchResult;
  try {
    fetched = await fetchSlackThread(env.SLACK_USER_TOKEN, url);
  } catch (e) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: `⚠️ Slack fetch failed: <code>${escapeHtml(e instanceof Error ? e.message : String(e))}</code>`,
      parseMode: "HTML",
      disableWebPagePreview: true,
    });
    return;
  }

  const store = kvSessionStore(env.CTXD_SESSIONS);
  const session = (await store.get(chatId)) ?? newSession();
  const n = session.sources.length + 1;

  const rootLean = renderLeanBlock(fetched.rootMessage);
  const replyLeans = fetched.replies.map(renderLeanBlock);

  const source: CtxdSource = {
    n,
    url,
    type: "slack",
    fetchedAt: new Date().toISOString(),
    content: fetched.markdown,
    channelHeader: fetched.channelHeader,
    rootLean,
    replyLeans,
    nestedSlackLinks: fetched.nestedSlackLinks,
  };

  const prompt = translateRootPrompt(
    n,
    url,
    fetched.channelHeader,
    rootLean,
    fetched.replies.length,
    fetched.nestedSlackLinks.length,
  );

  session.sources.push(source);
  session.messages.push({ role: "user", content: prompt });

  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: "⏳ 翻译中…",
    parseMode: "HTML",
    disableWebPagePreview: true,
  });

  const keyboard = buildKeyboard(n, fetched.replies.length, fetched.nestedSlackLinks.length);
  await callLlmAndRender(env, chatId, progressId, session, keyboard);
}

function findSource(session: Session, n: number): CtxdSource | undefined {
  return session.sources.find((s) => s.n === n) as CtxdSource | undefined;
}

async function translateReply(
  env: Env,
  chatId: number,
  sourceN: number,
  replyIdx: number,
): Promise<void> {
  const store = kvSessionStore(env.CTXD_SESSIONS);
  const session = await store.get(chatId);
  if (!session) return replyPlain(env, chatId, "Session expired. 发新 URL 重开。");
  const source = findSource(session, sourceN);
  if (!source) return replyPlain(env, chatId, `Source ${sourceN} not found.`);
  const blocks = source.replyLeans ?? [];
  if (replyIdx < 1 || replyIdx > blocks.length) {
    return replyPlain(env, chatId, `回复 ${replyIdx} 越界 (1-${blocks.length}).`);
  }

  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: `⏳ 翻译回复 ${replyIdx}…`,
  });
  const prompt = translateReplyPrompt(sourceN, replyIdx, blocks.length, blocks[replyIdx - 1]!);
  session.messages.push({ role: "user", content: prompt });
  await callLlmAndRender(env, chatId, progressId, session);
}

async function translateQuote(
  env: Env,
  chatId: number,
  sourceN: number,
  quoteIdx: number,
): Promise<void> {
  const store = kvSessionStore(env.CTXD_SESSIONS);
  const session = await store.get(chatId);
  if (!session) return replyPlain(env, chatId, "Session expired. 发新 URL 重开。");
  const source = findSource(session, sourceN);
  if (!source) return replyPlain(env, chatId, `Source ${sourceN} not found.`);
  const links = source.nestedSlackLinks ?? [];
  if (quoteIdx < 1 || quoteIdx > links.length) {
    return replyPlain(env, chatId, `引用 ${quoteIdx} 越界 (1-${links.length}).`);
  }
  const link = links[quoteIdx - 1]!;

  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: `⏳ 拉取引用 ${quoteIdx}…`,
  });

  let single: SingleMessageResult;
  try {
    single = await fetchSingleMessage(env.SLACK_USER_TOKEN, link.url);
  } catch (e) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: `⚠️ Quote fetch failed: <code>${escapeHtml(e instanceof Error ? e.message : String(e))}</code>`,
      parseMode: "HTML",
      disableWebPagePreview: true,
    });
    return;
  }

  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: `⏳ 翻译引用 ${quoteIdx}…`,
    parseMode: "HTML",
    disableWebPagePreview: true,
  });

  const leanBlock = renderLeanBlock(single.message);
  const prompt = translateQuotePrompt(
    sourceN,
    quoteIdx,
    link.url,
    single.channelHeader,
    leanBlock,
    single.isThreadReply,
  );
  session.messages.push({ role: "user", content: prompt });
  await callLlmAndRender(env, chatId, progressId, session);
}

async function followUp(env: Env, chatId: number, session: Session, text: string): Promise<void> {
  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: "⏳ 思考中…",
  });
  session.messages.push({ role: "user", content: text });
  await callLlmAndRender(env, chatId, progressId, session);
}

async function showStatus(env: Env, chatId: number): Promise<void> {
  const session = await kvSessionStore(env.CTXD_SESSIONS).get(chatId);
  if (!session) return replyPlain(env, chatId, "No active session.");
  const lines = [
    `Session since: <code>${escapeHtml(session.createdAt)}</code>`,
    `Messages: ${session.messages.length}`,
    `Sources (${session.sources.length}):`,
  ];
  for (const raw of session.sources) {
    const s = raw as CtxdSource;
    const replies = (s.replyLeans ?? []).length;
    const quotes = (s.nestedSlackLinks ?? []).length;
    lines.push(`${s.n}. ${escapeHtml(s.url)} — ${replies} 回复, ${quotes} 引用`);
  }
  return replyPlain(env, chatId, lines.join("\n"));
}

async function resetSession(env: Env, chatId: number): Promise<void> {
  await kvSessionStore(env.CTXD_SESSIONS).delete(chatId);
  return replyPlain(env, chatId, "Session reset. 发 Slack URL 重新开始。");
}

async function handleUserMessage(env: Env, chatId: number, rawText: string): Promise<void> {
  const text = rawText.trim();

  if (text === "/reset" || text === "/new") return resetSession(env, chatId);
  if (text === "/status") return showStatus(env, chatId);

  const { url, multiple } = extractFirstUrl(text);
  if (multiple) return replyPlain(env, chatId, "一次只发一个 URL 哦。");
  if (url) {
    if (!isSlackUrl(url)) return replyPlain(env, chatId, "目前只支持 Slack URL。");
    return ingestSlack(env, chatId, url);
  }

  const session = await kvSessionStore(env.CTXD_SESSIONS).get(chatId);
  if (!session) return replyPlain(env, chatId, "发个 Slack URL 开始 session。");
  return followUp(env, chatId, session, text);
}

async function handleCallback(env: Env, cq: CallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  if (!chatId) return;
  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id).catch(() => {});

  const match = (cq.data ?? "").match(CALLBACK_RE);
  if (!match) return;
  const kind = match[1]!;
  const sourceN = Number.parseInt(match[2]!, 10);
  const idx = Number.parseInt(match[3]!, 10);

  if (kind === "r") return translateReply(env, chatId, sourceN, idx);
  if (kind === "q") return translateQuote(env, chatId, sourceN, idx);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("ctxd-bot", { status: 200 });
    }
    if (!verifyWebhookSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await req.json()) as TelegramUpdate;
    if (!isAllowedChat(update, env.ALLOWED_CHAT_ID)) return new Response("ok");

    if (update.callback_query) {
      ctx.waitUntil(handleCallback(env, update.callback_query));
      return new Response("ok");
    }

    const msg = update.message ?? update.edited_message;
    const text = msg?.text;
    if (msg && text) {
      ctx.waitUntil(handleUserMessage(env, msg.chat.id, text));
    }
    return new Response("ok");
  },
};
