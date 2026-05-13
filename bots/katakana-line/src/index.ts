import { allowChatIdWithCap } from "shared/auth";
import { lookup } from "shared/jotoba";
import {
  getSignatureHeader,
  type LineEvent,
  type LineWebhook,
  replyMessages,
  replyText,
  verifyLineSignature,
} from "shared/line";
import { buildEntryFlex } from "./flex.ts";

interface Env {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  MAX_CHATS: string;
  CHATS: KVNamespace;
  KATAKANA_CACHE: KVNamespace;
}

const INTRO =
  "👋 Send me a word and I'll return the Japanese reading.\n\n" +
  "Examples:\n" +
  "• 勉強 → べんきょう (study)\n" +
  "• computer → コンピュータ\n" +
  "• 学习 → 学習（がくしゅう）";

async function handleEvent(env: Env, event: LineEvent, maxChats: number): Promise<void> {
  console.log("event in:", {
    type: event.type,
    msgType: event.message?.type,
    text: event.message?.text,
    srcType: event.source?.type,
    hasToken: !!event.replyToken,
  });
  if (event.source?.type !== "user" || !event.source.userId || !event.replyToken) {
    console.log("event skipped (not private user or no token)");
    return;
  }
  const userId = event.source.userId;

  if (event.type === "follow") {
    const ok = await allowChatIdWithCap(`line:${userId}`, env.CHATS, maxChats);
    const msg = ok ? INTRO : "Sorry — this bot is currently full. Try again later.";
    await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, msg);
    return;
  }

  if (event.type !== "message" || event.message?.type !== "text") return;
  if (!(await allowChatIdWithCap(`line:${userId}`, env.CHATS, maxChats))) return;

  const text = (event.message.text ?? "").trim();
  if (!text) return;

  if (text === "/start" || text === "/help") {
    await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, INTRO);
    return;
  }

  console.log("looking up:", text);
  const result = await lookup(text, env.KATAKANA_CACHE);
  console.log("lookup result:", result.kind);

  if (result.kind === "ok") {
    await replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, [
      buildEntryFlex(result.entry),
    ]);
    return;
  }

  const reply =
    result.kind === "notfound"
      ? `Not found: ${result.query}`
      : `⚠️ Lookup failed: ${result.reason}`;
  await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("cc-katakana-line-bot", { status: 200 });
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
            console.error("line event handler error:", e);
          }
        }
      })(),
    );
    return new Response("ok");
  },
};
