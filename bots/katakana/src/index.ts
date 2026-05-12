import { isAllowedChat, verifyWebhookSecret } from "shared/auth";
import {
  answerCallbackQuery,
  editMessageText,
  escapeHtml,
  type InlineKeyboardMarkup,
  sendMessage,
} from "shared/telegram";
import type { TelegramUpdate } from "shared/types";
import { lookup, type LookupResult } from "./jisho.ts";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
}

const RETRY_PREFIX = "retry:";

function retryKeyboard(query: string): InlineKeyboardMarkup | undefined {
  const data = `${RETRY_PREFIX}${query}`;
  if (new TextEncoder().encode(data).byteLength > 64) return undefined;
  return { inline_keyboard: [[{ text: "🔄 Retry", callback_data: data }]] };
}

function renderResult(result: LookupResult): { text: string; keyboard?: InlineKeyboardMarkup } {
  switch (result.kind) {
    case "ok":
      return { text: result.html };
    case "notfound":
      return { text: `Not found: <code>${escapeHtml(result.query)}</code>` };
    case "error":
      return {
        text:
          `⚠️ Lookup failed: <code>${escapeHtml(result.reason)}</code>\n` +
          `Query: <code>${escapeHtml(result.query)}</code>`,
        keyboard: retryKeyboard(result.query),
      };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("katakana-bot", { status: 200 });
    }
    if (!verifyWebhookSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await req.json()) as TelegramUpdate;
    if (!isAllowedChat(update, env.ALLOWED_CHAT_ID)) {
      return new Response("ok");
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      if (cb.data?.startsWith(RETRY_PREFIX) && cb.message) {
        const query = cb.data.slice(RETRY_PREFIX.length);
        const result = await lookup(query);
        const { text, keyboard } = renderResult(result);
        await editMessageText(env.TELEGRAM_BOT_TOKEN, {
          chatId: cb.message.chat.id,
          messageId: cb.message.message_id,
          text,
          parseMode: "HTML",
          disableWebPagePreview: true,
          replyMarkup: keyboard,
        });
      }
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cb.id);
      return new Response("ok");
    }

    const msg = update.message ?? update.edited_message;
    const text = msg?.text?.trim();
    if (!msg || !text) return new Response("ok");

    const result = await lookup(text);
    const { text: replyText, keyboard } = renderResult(result);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, {
      chatId: msg.chat.id,
      text: replyText,
      disableWebPagePreview: true,
      parseMode: "HTML",
      replyMarkup: keyboard,
    });
    return new Response("ok");
  },
};
