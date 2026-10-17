import { isAllowedChat, verifyWebhookSecret } from "shared/auth";
import { deleteMessage, escapeHtml, sendMessage } from "shared/telegram";
import type { TelegramUpdate } from "shared/types";
import {
  addStickersUrl,
  fetchMeta,
  isAnimated,
  parseProductId,
  pickTitle,
  stickerSetName,
} from "./line.ts";
import { addSetKeyboard, getBotUsername, getStickerSet, SET_MAX, sendSticker } from "./stickers.ts";

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
  "发一个 LINE 贴纸商店链接，我会把整个包转成 Telegram 贴纸集，动态贴纸保留动画。\n\n" +
  "例：https://store.line.me/stickershop/product/8525/ja\n" +
  "也支持分享链接（line.me/S/sticker/…）和商品 ID。";

let botUsername: string | undefined;

// The import job deletes the progress message before sending the result.
async function dispatchImport(env: Env, productId: string, progressId: number): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.IMPORT_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "user-agent": "linesticker-bot",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "master", inputs: { product_id: productId, progress_message_id: String(progressId) } }),
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
      ? "只支持贴纸包，不支持表情（emoji）和主题。"
      : "请发一个 LINE 贴纸商店链接。";
    await sendMessage(token, { chatId, text: hint });
    return;
  }

  const meta = await fetchMeta(productId);
  if (!meta) {
    await sendMessage(token, { chatId, text: `找不到 LINE 贴纸包 ${productId}。` });
    return;
  }
  const title = pickTitle(meta);
  const total = Math.min(meta.stickers.length, SET_MAX);

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

  const kind = isAnimated(meta) ? "动态" : "静态";
  const resume = set ? `（从第 ${set.stickers.length + 1} 张继续）` : "";
  const progressId = await sendMessage(token, {
    chatId,
    parseMode: "HTML",
    text:
      `⏳ 正在导入 <b>${escapeHtml(title)}</b>：${total} 张${kind}贴纸${resume}\n` +
      "通常需要 1–3 分钟。",
  });
  try {
    await dispatchImport(env, productId, progressId);
  } catch (e) {
    await deleteMessage(token, chatId, progressId).catch(() => {});
    throw e;
  }
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
          text: `⚠️ 出错了：${String(err).slice(0, 500)}`,
        }).catch(() => {});
      }),
    );
    return new Response("ok");
  },
};
