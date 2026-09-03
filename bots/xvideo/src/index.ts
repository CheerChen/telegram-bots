import { allowChatWithCap, verifyWebhookSecret } from "shared/auth";
import { extractStatusId, fetchTweet } from "shared/fxtwitter";
import { fetchWeiboPost, extractWeiboId } from "shared/weibo";
import { escapeHtml, sendMessage, sendVideo, sendVideoFile } from "shared/telegram";
import type { TelegramUpdate } from "shared/types";
import { isTelegramSendable, probeTelegramVideoUrl } from "./telegram-video.ts";

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

    try {
      const update = (await req.json()) as TelegramUpdate;
      return await handleUpdate(update, env);
    } catch (err) {
      // Ack with 200 even on failure: a non-200 makes Telegram re-deliver
      // the same update for hours.
      console.error("webhook handler failed", err);
      return new Response("ok");
    }
  },
};

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<Response> {
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
        "👋 Send me a post URL and I'll grab the video.\n\n" +
        "X / Twitter:\n" +
        "<code>https://x.com/user/status/1234567890</code>\n" +
        "Supported hosts: x.com, twitter.com, fxtwitter.com, vxtwitter.com, fixupx.com\n\n" +
        "Weibo:\n" +
        "<code>https://weibo.com/1195908387/RfO2JFuk3</code>\n" +
        "Supported hosts: weibo.com, m.weibo.cn\n\n" +
        "X/Twitter videos >20MB come back as a direct link.\n" +
        "Weibo videos are downloaded and uploaded (no size limit).",
      parseMode: "HTML",
      disableWebPagePreview: true,
    });
    return new Response("ok");
  }

  const statusId = extractStatusId(text);
  if (statusId) {
    return await handleTwitter(statusId, msg, env);
  }

  const weiboId = extractWeiboId(text);
  if (weiboId) {
    return await handleWeibo(weiboId, msg, env);
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId: msg.chat.id,
    text: "Send me an X/Twitter or Weibo post URL.",
    replyToMessageId: msg.message_id,
  });
  return new Response("ok");
}

async function handleTwitter(
  statusId: string,
  msg: NonNullable<TelegramUpdate["message"]>,
  env: Env,
): Promise<Response> {
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
    if (!isTelegramSendable(video)) continue;

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
}

async function handleWeibo(
  weiboId: string,
  msg: NonNullable<TelegramUpdate["message"]>,
  env: Env,
): Promise<Response> {
  const result = await fetchWeiboPost(weiboId);

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
      text: "No video found in that Weibo post.",
      replyToMessageId: msg.message_id,
    });
    return new Response("ok");
  }

  const { post } = result;
  const author = post.author ?? "";
  const body = post.text ?? "";
  const baseCaption = [author, body].filter(Boolean).join("\n").slice(0, 900);
  const total = post.videos.length;

  // Download and upload each video sequentially.
  // Weibo CDN requires Referer: https://weibo.com/ on download.
  for (let i = 0; i < post.videos.length; i++) {
    const video = post.videos[i]!;
    const index = i + 1;
    const caption =
      total > 1
        ? `${baseCaption}\n(${index}/${total})`
        : baseCaption;

    try {
      const res = await fetch(video.url, {
        headers: { referer: "https://weibo.com/", "user-agent": "cc-xvideo-bot/0.1" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`download http ${res.status}`);

      const buf = await res.arrayBuffer();
      await sendVideoFile(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        video: buf,
        filename: `weibo_${post.mblogid ?? weiboId}_${index}.mp4`,
        caption: caption.slice(0, 1024),
        supportsStreaming: true,
        replyToMessageId: i === 0 ? msg.message_id : undefined,
      });
    } catch (e) {
      // Fallback: send direct link if download/upload fails.
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: msg.chat.id,
        text:
          `📹 ${escapeHtml(caption)}\n` +
          `<a href="${escapeHtml(video.url)}">direct link</a>\n` +
          `<i>${escapeHtml((e as Error).message)}</i>`,
        parseMode: "HTML",
        replyToMessageId: msg.message_id,
      });
    }
  }
  return new Response("ok");
}
