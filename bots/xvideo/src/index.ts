import { allowChatWithCap, verifyWebhookSecret } from "shared/auth";
import { escapeHtml, sendMessage, sendVideo } from "shared/telegram";
import type { TelegramUpdate } from "shared/types";
import { extractStatusId, fetchTweet, probeTelegramVideoUrl } from "./fxtwitter.ts";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MAX_CHATS: string;
  CHATS: KVNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("cc-xvideo-bot", { status: 200 });
    }
    if (!verifyWebhookSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await req.json()) as TelegramUpdate;
    const maxChats = parseInt(env.MAX_CHATS, 10) || 50;
    if (!(await allowChatWithCap(update, env.CHATS, maxChats))) {
      return new Response("ok");
    }

    const msg = update.message ?? update.edited_message;
    const text = msg?.text?.trim();
    if (!msg || !text) return new Response("ok");

    if (text === "/start" || text === "/help") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        text:
          "👋 Send me an X / Twitter post URL and I'll grab the video.\n\n" +
          "Example:\n" +
          "<code>https://x.com/user/status/1234567890</code>\n\n" +
          "Supported hosts: x.com, twitter.com, fxtwitter.com, vxtwitter.com, fixupx.com\n" +
          "Videos >20MB will come back as a direct link instead of an inline player.",
        parseMode: "HTML",
        disableWebPagePreview: true,
      });
      return new Response("ok");
    }

    const statusId = extractStatusId(text);
    if (!statusId) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        text: "Send me an X/Twitter post URL.",
        replyToMessageId: msg.message_id,
      });
      return new Response("ok");
    }

    const result = await fetchTweet(statusId);

    if (result.kind === "error") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        text: `⚠️ <code>${escapeHtml(result.reason)}</code>`,
        parseMode: "HTML",
        replyToMessageId: msg.message_id,
      });
      return new Response("ok");
    }

    if (result.kind === "novideo") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        text: "No video found in that tweet.",
        replyToMessageId: msg.message_id,
      });
      return new Response("ok");
    }

    const { candidates, tweet } = result;
    const author = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : "";
    const body = tweet.text ?? "";
    const caption = [author, body].filter(Boolean).join("\n").slice(0, 1024);

    // Try candidates from highest to lowest quality.
    // Skip known-oversized; probe the rest to find one Telegram can send.
    let sent = false;
    const best = candidates[0]!;
    for (const video of candidates) {
      if (!video.telegramReady) continue;

      const probe = await probeTelegramVideoUrl(video.url);
      if (!probe.ok) continue;

      try {
        await sendVideo(env.TELEGRAM_BOT_TOKEN, {
          chatId: msg.chat.id,
          video: video.url,
          caption:
            video !== best
              ? `${caption}\n(${video.width ?? "?"}×${video.height ?? "?"})`
              : caption,
          supportsStreaming: true,
          replyToMessageId: msg.message_id,
        });
        sent = true;
        break;
      } catch {
        continue;
      }
    }

    if (!sent) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        text:
          `📹 ${escapeHtml(caption)}\n` +
          `<a href="${escapeHtml(best.url)}">direct link</a>\n` +
          `<i>(all qualities exceed 20 MB)</i>`,
        parseMode: "HTML",
        replyToMessageId: msg.message_id,
      });
    }
    return new Response("ok");
  },
};
