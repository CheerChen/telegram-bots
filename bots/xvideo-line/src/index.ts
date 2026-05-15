import { allowChatIdWithCap } from "shared/auth";
import { extractStatusId, fetchTweet, type SelectedVideo } from "shared/fxtwitter";
import {
  getSignatureHeader,
  type LineEvent,
  type LineMessageOut,
  type LineWebhook,
  replyMessages,
  replyText,
  verifyLineSignature,
} from "shared/line";
import {
  buildTweetLinkFlex,
  buildVideoMessage,
  formatVideoCaption,
} from "./flex.ts";
import { probeLineVideoUrl } from "./probe.ts";
import { isLineCompatible, pickFallbackThumbnail, unplayableReason } from "./select.ts";

interface Env {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  MAX_CHATS: string;
  CHATS: KVNamespace;
}

const INTRO =
  "👋 Send me an X / Twitter post URL and I'll grab the video.\n\n" +
  "Examples:\n• https://x.com/user/status/1234567890\n\n" +
  "Inline playback needs MP4 ≤ 60s. Longer or HLS-only videos come back as a link card.";

function permalink(authorScreenName: string | undefined, statusId: string): string {
  return `https://x.com/${authorScreenName ?? "i"}/status/${statusId}`;
}

async function pickPlayable(candidates: SelectedVideo[]): Promise<SelectedVideo | null> {
  for (const v of candidates) {
    if (!isLineCompatible(v)) continue;
    if (await probeLineVideoUrl(v.url)) return v;
  }
  return null;
}

async function handleEvent(env: Env, ev: LineEvent, maxChats: number): Promise<void> {
  if (ev.source?.type !== "user" || !ev.source.userId || !ev.replyToken) return;
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const rt = ev.replyToken;
  const chatKey = `line:${ev.source.userId}`;

  if (ev.type === "follow") {
    const ok = await allowChatIdWithCap(chatKey, env.CHATS, maxChats);
    await replyText(
      token,
      rt,
      ok ? INTRO : "Sorry — this bot is currently full. Try again later.",
    );
    return;
  }

  if (ev.type !== "message" || ev.message?.type !== "text") return;
  if (!(await allowChatIdWithCap(chatKey, env.CHATS, maxChats))) return;

  const text = (ev.message.text ?? "").trim();
  if (!text) return;
  if (text === "/start" || text === "/help") {
    await replyText(token, rt, INTRO);
    return;
  }

  const statusId = extractStatusId(text);
  if (!statusId) {
    await replyText(token, rt, "Send me an X / Twitter post URL.");
    return;
  }

  const result = await fetchTweet(statusId);
  if (result.kind === "error") {
    await replyText(token, rt, `⚠️ ${result.reason}`);
    return;
  }
  if (result.kind === "novideo") {
    await replyText(token, rt, "No video found in that tweet.");
    return;
  }

  const { tweet, candidates } = result;
  const author = tweet.author?.screen_name;
  const url = permalink(author, statusId);

  const chosen = await pickPlayable(candidates);
  if (chosen) {
    const caption = formatVideoCaption({ author, text: tweet.text, video: chosen });
    const messages: LineMessageOut[] = [];
    if (caption) messages.push({ type: "text", text: caption.slice(0, 5000) });
    messages.push(buildVideoMessage(chosen));
    await replyMessages(token, rt, messages);
    return;
  }

  const fb = pickFallbackThumbnail(candidates);
  const reason = unplayableReason(candidates);
  if (fb) {
    await replyMessages(token, rt, [
      buildTweetLinkFlex({
        author,
        text: tweet.text,
        permalink: url,
        thumbnail: fb.url,
        width: fb.width,
        height: fb.height,
        reason,
      }),
    ]);
    return;
  }

  await replyText(token, rt, `${tweet.text ?? ""}\n\n${url}\n(${reason})`);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("cc-xvideo-line-bot", { status: 200 });
    }

    const bodyText = await req.text();
    const sig = getSignatureHeader(req);
    if (!(await verifyLineSignature(bodyText, sig, env.LINE_CHANNEL_SECRET))) {
      return new Response("forbidden", { status: 403 });
    }

    const update = JSON.parse(bodyText) as LineWebhook;
    const maxChats = parseInt(env.MAX_CHATS, 10) || 50;

    ctx.waitUntil(
      (async () => {
        for (const event of update.events ?? []) {
          try {
            await handleEvent(env, event, maxChats);
          } catch (e) {
            console.error("xvideo-line event error:", e);
          }
        }
      })(),
    );
    return new Response("ok");
  },
};
