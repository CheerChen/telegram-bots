import { isAllowedChat, verifyWebhookSecret } from "shared/auth";
import { chat, type Message as LlmMessage } from "shared/llm";
import {
  kvSessionStore,
  newSession,
  type Session,
  type SessionSource,
  touch,
} from "shared/session";
import { editMessageText, escapeHtml, sendMessage } from "shared/telegram";
import type { TelegramUpdate } from "shared/types";
import { additionalSourcePrompt, initialSourcePrompt, SYSTEM_PROMPT } from "./prompts.ts";
import { fetchSlackThread, isSlackUrl } from "./slack.ts";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  SLACK_USER_TOKEN: string;
  CTXD_SESSIONS: KVNamespace;
}

const URL_RE = /https?:\/\/\S+/g;
const TG_MAX_LEN = 3900;

function llmToHtml(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return out;
}

function truncate(s: string): string {
  return s.length > TG_MAX_LEN ? `${s.slice(0, TG_MAX_LEN - 15)}\n…(truncated)` : s;
}

function buildLlmMessages(session: Session): LlmMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages];
}

function extractUrlAndNote(text: string): { url?: string; note: string; multiple: boolean } {
  const urls = text.match(URL_RE) ?? [];
  if (urls.length === 0) return { note: text, multiple: false };
  if (urls.length > 1) return { note: text, multiple: true };
  const url = urls[0]!;
  return { url, note: text.replace(url, "").trim(), multiple: false };
}

async function replyPlain(env: Env, chatId: number, text: string): Promise<void> {
  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text,
    parseMode: "HTML",
    disableWebPagePreview: true,
  });
}

async function ingestSlack(
  env: Env,
  chatId: number,
  url: string,
  note: string,
): Promise<void> {
  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: "⏳ Fetching Slack thread…",
  });

  let fetched: Awaited<ReturnType<typeof fetchSlackThread>>;
  try {
    fetched = await fetchSlackThread(env.SLACK_USER_TOKEN, url);
  } catch (e) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: `⚠️ Slack fetch failed: <code>${escapeHtml(e instanceof Error ? e.message : String(e))}</code>\nSession unchanged.`,
      parseMode: "HTML",
      disableWebPagePreview: true,
    });
    return;
  }

  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: `⏳ Asking <code>${escapeHtml(env.LLM_MODEL)}</code>…`,
    parseMode: "HTML",
    disableWebPagePreview: true,
  });

  const store = kvSessionStore(env.CTXD_SESSIONS);
  const session = (await store.get(chatId)) ?? newSession();
  const n = session.sources.length + 1;
  const source: SessionSource = {
    n,
    url,
    type: "slack",
    fetchedAt: new Date().toISOString(),
    content: fetched.markdown,
  };
  const userPrompt =
    n === 1
      ? initialSourcePrompt(url, fetched.markdown)
      : additionalSourcePrompt(n, url, fetched.markdown, note || undefined);
  session.sources.push(source);
  session.messages.push({ role: "user", content: userPrompt });

  let answer: string;
  try {
    answer = await chat(env, buildLlmMessages(session));
  } catch (e) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: `⚠️ LLM call failed: <code>${escapeHtml(e instanceof Error ? e.message : String(e))}</code>\nSession unchanged.`,
      parseMode: "HTML",
      disableWebPagePreview: true,
    });
    return;
  }

  session.messages.push({ role: "assistant", content: answer });
  await store.put(chatId, touch(session));

  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: truncate(llmToHtml(answer)),
    parseMode: "HTML",
    disableWebPagePreview: true,
  });
}

async function followUp(env: Env, chatId: number, session: Session, text: string): Promise<void> {
  const progressId = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: `⏳ Asking <code>${escapeHtml(env.LLM_MODEL)}</code>…`,
    parseMode: "HTML",
  });

  session.messages.push({ role: "user", content: text });
  let answer: string;
  try {
    answer = await chat(env, buildLlmMessages(session));
  } catch (e) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      messageId: progressId,
      text: `⚠️ LLM call failed: <code>${escapeHtml(e instanceof Error ? e.message : String(e))}</code>`,
      parseMode: "HTML",
      disableWebPagePreview: true,
    });
    return;
  }

  session.messages.push({ role: "assistant", content: answer });
  await kvSessionStore(env.CTXD_SESSIONS).put(chatId, touch(session));

  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId: progressId,
    text: truncate(llmToHtml(answer)),
    parseMode: "HTML",
    disableWebPagePreview: true,
  });
}

async function showStatus(env: Env, chatId: number): Promise<void> {
  const session = await kvSessionStore(env.CTXD_SESSIONS).get(chatId);
  if (!session) return replyPlain(env, chatId, "No active session.");
  const lines = [
    `Session since: <code>${escapeHtml(session.createdAt)}</code>`,
    `Messages: ${session.messages.length}`,
    `Sources (${session.sources.length}):`,
    ...session.sources.map((s) => `${s.n}. ${escapeHtml(s.url)}`),
  ];
  return replyPlain(env, chatId, lines.join("\n"));
}

async function resetSession(env: Env, chatId: number): Promise<void> {
  await kvSessionStore(env.CTXD_SESSIONS).delete(chatId);
  return replyPlain(env, chatId, "Session reset. Send a Slack URL to start a new one.");
}

async function handleUserMessage(env: Env, chatId: number, rawText: string): Promise<void> {
  const text = rawText.trim();

  if (text === "/reset" || text === "/new") return resetSession(env, chatId);
  if (text === "/status") return showStatus(env, chatId);

  const { url, note, multiple } = extractUrlAndNote(text);
  if (multiple) return replyPlain(env, chatId, "Please send one URL at a time.");
  if (url) {
    if (!isSlackUrl(url)) return replyPlain(env, chatId, "Only Slack URLs are supported for now.");
    return ingestSlack(env, chatId, url, note);
  }

  const session = await kvSessionStore(env.CTXD_SESSIONS).get(chatId);
  if (!session) return replyPlain(env, chatId, "Send a Slack URL to start a session.");
  return followUp(env, chatId, session, text);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("ctxd-bot", { status: 200 });
    }
    if (!verifyWebhookSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await req.json()) as TelegramUpdate;
    if (!isAllowedChat(update, env.ALLOWED_CHAT_ID)) return new Response("ok");

    const msg = update.message ?? update.edited_message;
    const text = msg?.text;
    if (!msg || !text) return new Response("ok");

    await handleUserMessage(env, msg.chat.id, text);
    return new Response("ok");
  },
};
