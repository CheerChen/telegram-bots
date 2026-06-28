import { allowChatWithCap, verifyWebhookSecret } from "shared/auth";
import {
  answerCallbackQuery,
  editMessageText,
  escapeHtml,
  type InlineKeyboardMarkup,
  sendMessage,
} from "shared/telegram";
import type { TelegramUpdate } from "shared/types";
import { lookup, type LookupResult, renderHtml, renderPlain } from "shared/dict";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MAX_CHATS: string;
  CHATS: KVNamespace;
  KATAKANA_CACHE: KVNamespace;
  CLAW_WORKER_SECRET?: string;
}

interface IlinkRequest {
  userId?: string;
  text?: string;
}

function renderPlainResult(result: LookupResult): string {
  switch (result.kind) {
    case "ok":
      return renderPlain(result.entry);
    case "notfound":
      return `Not found: ${result.query}`;
    case "error":
      return `Lookup failed: ${result.reason}`;
  }
}

const RETRY_PREFIX = "retry:";
const EMPTY_KEYBOARD: InlineKeyboardMarkup = { inline_keyboard: [] };

function retryKeyboard(query: string): InlineKeyboardMarkup {
  const data = `${RETRY_PREFIX}${query}`;
  if (new TextEncoder().encode(data).byteLength > 64) return EMPTY_KEYBOARD;
  return { inline_keyboard: [[{ text: "🔄 Retry", callback_data: data }]] };
}

function renderResult(result: LookupResult): { text: string; keyboard: InlineKeyboardMarkup } {
  switch (result.kind) {
    case "ok":
      return { text: renderHtml(result.entry), keyboard: EMPTY_KEYBOARD };
    case "notfound":
      return {
        text: `Not found: <code>${escapeHtml(result.query)}</code>`,
        keyboard: EMPTY_KEYBOARD,
      };
    case "error":
      return {
        text:
          `⚠️ Lookup failed: <code>${escapeHtml(result.reason)}</code>\n` +
          `Query: <code>${escapeHtml(result.query)}</code>`,
        keyboard: retryKeyboard(result.query),
      };
  }
}

function loadingText(query: string, retry: boolean): string {
  const verb = retry ? "Retrying" : "Looking up";
  return `⏳ ${verb} <code>${escapeHtml(query)}</code>…`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/ilink") {
      if (!env.CLAW_WORKER_SECRET) return new Response("not configured", { status: 503 });
      if (req.headers.get("x-claw-secret") !== env.CLAW_WORKER_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await req.json().catch(() => null)) as IlinkRequest | null;
      const text = body?.text?.trim();
      if (!text) {
        return Response.json({ error: "missing text" }, { status: 400 });
      }
      const result = await lookup(text, env.KATAKANA_CACHE);
      return Response.json({ text: renderPlainResult(result) });
    }

    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("katakana-bot", { status: 200 });
    }
    if (!verifyWebhookSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await req.json()) as TelegramUpdate;
    const maxChats = parseInt(env.MAX_CHATS, 10) || 50;
    if (!(await allowChatWithCap(update, env.CHATS, maxChats))) {
      return new Response("ok");
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      if (cb.data?.startsWith(RETRY_PREFIX) && cb.message) {
        const query = cb.data.slice(RETRY_PREFIX.length);
        const chatId = cb.message.chat.id;
        const messageId = cb.message.message_id;

        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cb.id);
        await editMessageText(env.TELEGRAM_BOT_TOKEN, {
          chatId,
          messageId,
          text: loadingText(query, true),
          parseMode: "HTML",
          disableWebPagePreview: true,
          replyMarkup: EMPTY_KEYBOARD,
        });

        const result = await lookup(query, env.KATAKANA_CACHE);
        const { text, keyboard } = renderResult(result);
        await editMessageText(env.TELEGRAM_BOT_TOKEN, {
          chatId,
          messageId,
          text,
          parseMode: "HTML",
          disableWebPagePreview: true,
          replyMarkup: keyboard,
        });
      } else {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cb.id);
      }
      return new Response("ok");
    }

    const msg = update.message ?? update.edited_message;
    const text = msg?.text?.trim();
    if (!msg || !text) return new Response("ok");

    if (text === "/start" || text === "/help") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        text:
          "👋 Send me a word and I'll return the Japanese reading.\n\n" +
          "Examples:\n" +
          "• <code>勉強</code> → べんきょう (study)\n" +
          "• <code>computer</code> → コンピューター\n" +
          "• <code>学习</code> → 学習（がくしゅう）\n\n" +
          "If the lookup fails, tap 🔄 Retry on the error message.",
        parseMode: "HTML",
        disableWebPagePreview: true,
      });
      return new Response("ok");
    }

    const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
      chatId: msg.chat.id,
      text: loadingText(text, false),
      parseMode: "HTML",
    });

    const result = await lookup(text, env.KATAKANA_CACHE);
    const { text: replyText, keyboard } = renderResult(result);
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId: msg.chat.id,
      messageId: progressId,
      text: replyText,
      parseMode: "HTML",
      disableWebPagePreview: true,
      replyMarkup: keyboard,
    });
    return new Response("ok");
  },
};
