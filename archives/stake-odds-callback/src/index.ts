import { answerCallbackQuery, sendMessage } from "shared/telegram";

// Cloudflare Worker that owns Telegram callback_query events for the
// stake-odds inline keyboard buttons. Replaces the long-polling loop that
// used to run on the Pi (which was fragile: 409 conflicts, long-connection
// drops, non-persisted offset replaying old clicks after restarts).
//
// Telegram pushes callback_query updates here via webhook. The Worker is
// stateless: every reply target (chat / thread / message_id) is carried in
// the update payload itself, so it needs nothing from the Pi. The Pi keeps
// owning the board (seed / edit / notify) and the Stake GraphQL fetch.

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  // Mirror of the secret_token passed to setWebhook. Telegram echoes it back
  // in the X-Telegram-Bot-Api-Secret-Token header on every push; we reject
  // any request whose header doesn't match.
  STAKE_CALLBACK_SECRET: string;
}

interface CallbackUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface CallbackQuery {
  id: string;
  from?: CallbackUser;
  data?: string;
  message?: {
    message_id: number;
    chat?: { id: number | string };
    message_thread_id?: number;
  };
}

interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

const PLAYFUL_LINES = [
  "{user} 有点手痒，点了 {button}！",
  "{user} 似乎对 {button} 有点兴趣...",
  "{user} 忍不住戳了一下 {button}",
  "{user} 觉得 {button} 值得一搏？",
  "{user} 对 {button} 心动了一下",
  "{user} 悄悄点了 {button}，以为没人看见",
  "{user} 在 {button} 上犹豫了 0.3 秒",
  "{user} 用手指给 {button} 投了一票",
  "{user} 被 {button} 勾住了眼神",
  "{user} 点了 {button}，钱包瑟瑟发抖",
];

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Liveness probe — no secret check so Docker/uptime monitors can hit it.
    if (req.method === "GET") return new Response("ok", { status: 200 });

    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Verify webhook secret. A missing/blank secret in env is a deploy bug —
    // fail closed rather than answering forged callbacks.
    const secret = req.headers.get("x-telegram-bot-api-secret-token");
    if (!env.STAKE_CALLBACK_SECRET || secret !== env.STAKE_CALLBACK_SECRET) {
      return new Response("forbidden", { status: 401 });
    }

    let update: Update;
    try {
      update = (await req.json()) as Update;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    // Non-callback updates (plain chat messages, etc.) — acknowledge so
    // Telegram stops redelivering. The Pi no longer uses getUpdates, so
    // these would otherwise pile up as pending webhook retries.
    const cq = update.callback_query;
    if (!cq) return new Response("ok", { status: 200 });

    // Always ack first to stop the client-side spinner. We pass no text —
    // the visible feedback is the sendMessage below (a persistent reply in
    // the topic, per product decision).
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id).catch((e) =>
      log(`answerCallbackQuery: ${String(e)}`),
    );

    const user = cq.from;
    const button = cq.data?.trim();
    const msg = cq.message;
    if (!user || !button || !msg || button === "noop") return ok();

    const chatId = msg.chat?.id;
    if (chatId === undefined) return ok();

    const name = user.first_name || user.username || "某人";
    const template = PLAYFUL_LINES[Math.floor(Math.random() * PLAYFUL_LINES.length)]!;
    const text = template.replace("{user}", name).replace("{button}", button);

    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId,
        messageThreadId: msg.message_thread_id,
        replyToMessageId: msg.message_id,
        text,
        disableWebPagePreview: true,
      });
    } catch (err) {
      // Ack succeeded already; a sendMessage failure (rare Telegram blip)
      // is preferable to returning non-200 and risking a duplicate message
      // on Telegram's retry. Log and move on.
      log(`playful reply: ${err instanceof Error ? err.message : String(err)}`);
    }
    return ok();
  },
};

function ok(): Response {
  return new Response("ok", { status: 200 });
}
