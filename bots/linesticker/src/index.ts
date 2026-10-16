import { isAllowedChat, verifyWebhookSecret } from "shared/auth";
import { escapeHtml, sendMessage } from "shared/telegram";
import type { TelegramUpdate } from "shared/types";
import {
  addStickersUrl,
  fetchMeta,
  isAnimated,
  parseProductId,
  pickTitle,
  stickerSetName,
} from "./line.ts";
import { addSetKeyboard, getBotUsername, getStickerSet, sendSticker } from "./stickers.ts";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  GITHUB_REPO: string;
  IMPORT_WORKFLOW: string;
  // Fine-grained PAT, this repo only, "Actions: Read and write".
  GITHUB_DISPATCH_TOKEN: string;
}

const INTRO =
  "Send me a LINE sticker store link and I'll turn the pack into a Telegram sticker set.\n\n" +
  "Example: https://store.line.me/stickershop/product/8525/ja";

let botUsername: string | undefined;

async function dispatchImport(env: Env, productId: string): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.IMPORT_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "user-agent": "linesticker-bot",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "master", inputs: { product_id: productId } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`github dispatch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function handleText(env: Env, chatId: number, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (text === "/start" || text === "/help") {
    await sendMessage(token, { chatId, text: INTRO, disableWebPagePreview: true });
    return;
  }

  const productId = parseProductId(text);
  if (!productId) {
    const hint = /line\.me\/(emojishop|themeshop)/.test(text)
      ? "Only sticker packs are supported (not emoji or themes)."
      : "Send a LINE sticker store link.";
    await sendMessage(token, { chatId, text: hint });
    return;
  }

  const meta = await fetchMeta(productId);
  if (!meta) {
    await sendMessage(token, { chatId, text: `No LINE sticker pack ${productId}.` });
    return;
  }
  const title = pickTitle(meta);
  const total = meta.stickers.length;

  botUsername ??= await getBotUsername(token);
  const name = stickerSetName(productId, botUsername);
  const set = await getStickerSet(token, name);
  const first = set?.stickers[0];
  if (set && first && set.stickers.length >= total) {
    await sendSticker(token, {
      chatId,
      fileId: first.file_id,
      replyMarkup: addSetKeyboard(addStickersUrl(name), title, total),
    });
    return;
  }

  await dispatchImport(env, productId);
  const kind = isAnimated(meta) ? "animated" : "static";
  const progress = set ? ` (resuming at ${set.stickers.length})` : "";
  await sendMessage(token, {
    chatId,
    parseMode: "HTML",
    text:
      `⏳ Importing <b>${escapeHtml(title)}</b>: ${total} ${kind} stickers${progress}.\n` +
      "Usually done in 1–3 minutes.",
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("linesticker-bot", { status: 200 });
    }
    if (!verifyWebhookSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await req.json()) as TelegramUpdate;
    const msg = update.message;
    if (!msg?.text || !isAllowedChat(update, env.ALLOWED_CHAT_ID)) {
      return new Response("ok");
    }
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Ack immediately; a non-200 makes Telegram re-deliver for hours.
    ctx.waitUntil(
      handleText(env, chatId, text).catch(async (err) => {
        console.error("linesticker handler failed", err);
        await sendMessage(env.TELEGRAM_BOT_TOKEN, {
          chatId,
          text: `⚠️ ${String(err).slice(0, 500)}`,
        }).catch(() => {});
      }),
    );
    return new Response("ok");
  },
};
