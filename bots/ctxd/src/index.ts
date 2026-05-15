import { isAllowedChat, verifyWebhookSecret } from "shared/auth";
import { chat, type Message as LlmMessage } from "shared/llm";
import {
  answerCallbackQuery,
  editMessageText,
  type InlineKeyboardMarkup,
  sendMessage,
} from "shared/telegram";
import type { CallbackQuery, TelegramUpdate } from "shared/types";
import {
  deleteContext,
  deleteLatestContextId,
  getContext,
  getLatestContextId,
  newContextId,
  putContext,
  setLatestContextId,
  type CachedContext,
} from "./cache.ts";
import { fetchContext, UnsupportedSourceError } from "./ctxd.ts";
import { buildActionPrompt, type ContextAction } from "./prompts.ts";
import { extractFirstUrl, sourceTypeName } from "./url.ts";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  SLACK_USER_TOKEN: string;
  CTXD_SESSIONS: KVNamespace;
  CLAW_WORKER_SECRET?: string;
}

interface IlinkRequest {
  userId?: string;
  text?: string;
}

const TG_MAX_LEN = 3900;
const CONTEXT_PROMPT_MAX_CHARS = 30_000;
const CALLBACK_RE = /^(summary|translate|draft):([a-z0-9]{12})$/;
const TELEGRAM_SCOPE = "telegram";
const ILINK_SCOPE = "ilink";

const NO_CONTEXT_TEXT = "找不到上下文。请重新发送链接。";
const READ_FAILED_TEXT = "链接读取失败。";
const LLM_FAILED_TEXT = "处理失败。请再试一次。";
const ONLY_SLACK_TEXT = "当前仅支持 Slack 链接。";
const SEND_LINK_TEXT = "请发送 Slack 链接。";
const ILINK_MENU_TEXT = "已读取 Slack 链接。请回复：\n1 总结\n2 翻译\n3 起草回复";

function truncateOutput(text: string): string {
  return text.length > TG_MAX_LEN ? `${text.slice(0, TG_MAX_LEN - 14)}\n…（已截断）` : text;
}

function truncateContext(markdown: string): { markdown: string; truncated: boolean } {
  if (markdown.length <= CONTEXT_PROMPT_MAX_CHARS) {
    return { markdown, truncated: false };
  }
  return { markdown: markdown.slice(0, CONTEXT_PROMPT_MAX_CHARS), truncated: true };
}

function actionKeyboard(contextId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "总结", callback_data: `summary:${contextId}` }],
      [{ text: "翻译", callback_data: `translate:${contextId}` }],
      [{ text: "起草回复", callback_data: `draft:${contextId}` }],
    ],
  };
}

function parseAction(text: string): ContextAction | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "1" || normalized === "总结" || normalized === "summary") return "summary";
  if (normalized === "2" || normalized === "翻译" || normalized === "translate") return "translate";
  if (normalized === "3" || normalized === "起草回复" || normalized === "draft") return "draft";
  return null;
}

async function replyPlain(env: Env, chatId: number, text: string): Promise<void> {
  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text,
    disableWebPagePreview: true,
  });
}

async function resetLatestContext(
  env: Env,
  scope: string,
  id: string | number,
): Promise<void> {
  const contextId = await getLatestContextId(env.CTXD_SESSIONS, scope, id);
  if (contextId) await deleteContext(env.CTXD_SESSIONS, contextId);
  await deleteLatestContextId(env.CTXD_SESSIONS, scope, id);
}

async function createContext(env: Env, url: string): Promise<CachedContext> {
  const fetched = await fetchContext(env.SLACK_USER_TOKEN, url);
  const context: CachedContext = {
    id: newContextId(),
    url,
    markdown: fetched.markdown,
    sourceType: fetched.sourceType,
    createdAt: new Date().toISOString(),
  };
  await putContext(env.CTXD_SESSIONS, context);
  return context;
}

async function runAction(env: Env, context: CachedContext, action: ContextAction): Promise<string> {
  const prepared = truncateContext(context.markdown);
  const prompt = buildActionPrompt(action, {
    url: context.url,
    sourceType: context.sourceType,
    markdown: prepared.markdown,
    truncated: prepared.truncated,
  });
  const messages: LlmMessage[] = [{ role: "user", content: prompt }];
  return chat(env, messages, { temperature: 0.2 });
}

async function ingestTelegramUrl(env: Env, chatId: number, url: string): Promise<void> {
  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: "正在读取链接...",
    disableWebPagePreview: true,
  });

  let context: CachedContext;
  try {
    context = await createContext(env, url);
  } catch (e) {
    if (!(e instanceof UnsupportedSourceError)) {
      console.error("ctxd fetch failed", e);
    }
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: e instanceof UnsupportedSourceError ? ONLY_SLACK_TEXT : READ_FAILED_TEXT,
      disableWebPagePreview: true,
    });
    return;
  }

  await setLatestContextId(env.CTXD_SESSIONS, TELEGRAM_SCOPE, chatId, context.id);
  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: `已读取 ${sourceTypeName(context.sourceType)} 链接。请选择操作：`,
    disableWebPagePreview: true,
    replyMarkup: actionKeyboard(context.id),
  });
}

async function handleTelegramAction(
  env: Env,
  chatId: number,
  contextId: string,
  action: ContextAction,
): Promise<void> {
  const context = await getContext(env.CTXD_SESSIONS, contextId);
  if (!context) {
    await replyPlain(env, chatId, NO_CONTEXT_TEXT);
    return;
  }

  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: `Asking ${env.LLM_MODEL}...`,
    disableWebPagePreview: true,
  });

  let answer: string;
  try {
    answer = await runAction(env, context, action);
  } catch (e) {
    console.error("llm call failed", e);
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: LLM_FAILED_TEXT,
      disableWebPagePreview: true,
    });
    return;
  }

  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: truncateOutput(answer),
    disableWebPagePreview: true,
  });
}

async function handleUserMessage(env: Env, chatId: number, rawText: string): Promise<void> {
  const text = rawText.trim();

  if (text === "/start" || text === "/help") {
    return replyPlain(env, chatId, "发送 Slack 链接后，我会提供三个操作：总结、翻译、起草回复。");
  }
  if (text === "/reset" || text === "/new") {
    await resetLatestContext(env, TELEGRAM_SCOPE, chatId);
    return replyPlain(env, chatId, "已清除上下文。请重新发送链接。");
  }

  const { url, multiple } = extractFirstUrl(text);
  if (multiple) return replyPlain(env, chatId, "一次请只发送一个链接。");
  if (!url) return replyPlain(env, chatId, SEND_LINK_TEXT);
  return ingestTelegramUrl(env, chatId, url);
}

async function handleCallback(env: Env, cq: CallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  if (!chatId) return;
  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id).catch(() => {});

  const match = (cq.data ?? "").match(CALLBACK_RE);
  if (!match) return;
  await handleTelegramAction(env, chatId, match[2]!, match[1] as ContextAction);
}

async function handleIlink(env: Env, req: Request): Promise<Response> {
  if (!env.CLAW_WORKER_SECRET) return new Response("not configured", { status: 503 });
  if (req.headers.get("x-claw-secret") !== env.CLAW_WORKER_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as IlinkRequest | null;
  const userId = body?.userId?.trim();
  const text = body?.text?.trim();
  if (!userId || !text) {
    return Response.json({ error: "missing userId or text" }, { status: 400 });
  }

  if (text === "/reset" || text === "/new") {
    await resetLatestContext(env, ILINK_SCOPE, userId);
    return Response.json({ text: "已清除上下文。请重新发送链接。" });
  }

  const { url, multiple } = extractFirstUrl(text);
  if (multiple) return Response.json({ text: "一次请只发送一个链接。" });

  if (url) {
    let context: CachedContext;
    try {
      context = await createContext(env, url);
    } catch (e) {
      if (!(e instanceof UnsupportedSourceError)) {
        console.error("ctxd fetch failed", e);
      }
      return Response.json({ text: e instanceof UnsupportedSourceError ? ONLY_SLACK_TEXT : READ_FAILED_TEXT });
    }

    await setLatestContextId(env.CTXD_SESSIONS, ILINK_SCOPE, userId, context.id);
    return Response.json({ text: ILINK_MENU_TEXT });
  }

  const action = parseAction(text);
  if (!action) {
    return Response.json({
      text: "请发送 Slack 链接，或在读取链接后回复：1 总结 / 2 翻译 / 3 起草回复",
    });
  }

  const contextId = await getLatestContextId(env.CTXD_SESSIONS, ILINK_SCOPE, userId);
  if (!contextId) return Response.json({ text: NO_CONTEXT_TEXT });
  const context = await getContext(env.CTXD_SESSIONS, contextId);
  if (!context) return Response.json({ text: NO_CONTEXT_TEXT });

  try {
    const answer = await runAction(env, context, action);
    return Response.json({ text: truncateOutput(answer) });
  } catch (e) {
    console.error("llm call failed", e);
    return Response.json({ text: LLM_FAILED_TEXT });
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/ilink") {
      return handleIlink(env, req);
    }

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
