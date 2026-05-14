import { extractText, sendTextMessage } from "ilink/protocol";
import type { WeixinMessage } from "ilink/types";

import type { ClawConfig } from "./config.ts";
import { callCtxd } from "./handlers/ctxd.ts";
import { callKatakana } from "./handlers/katakana.ts";
import type { ClawSession, SessionStore } from "./sessions.ts";
import type { HandlerName } from "./state.ts";

const CJK_RE = /^[぀-ヿ一-鿿]+$/;
const EN_WORD_RE = /^[a-zA-Z][a-zA-Z\-' ]{0,28}[a-zA-Z]?$/;
const CJK_MAX_LEN = 12;
const EN_MAX_LEN = 30;
const LOG_TEXT_MAX = 80;

const CMD_ENTER_CTXD = "/c";
const CMD_EXIT = "/q";
const CMD_RESET = "/r";

function looksLikeWordLookup(text: string): boolean {
  const t = text.trim();
  if (!t || /\n/.test(t) || /https?:\/\//i.test(t)) return false;
  if (CJK_RE.test(t)) return t.length <= CJK_MAX_LEN;
  if (/^[a-zA-Z]$/.test(t)) return true;
  if (EN_WORD_RE.test(t)) return t.length <= EN_MAX_LEN;
  return false;
}

function logLine(mode: string, from: string, text: string, result: string, ms?: number): void {
  const t = text.length > LOG_TEXT_MAX ? `${text.slice(0, LOG_TEXT_MAX)}…` : text;
  const duration = ms !== undefined ? ` ${ms}ms` : "";
  console.log(`[${mode}] from=${from} text=${JSON.stringify(t)} → ${result}${duration}`);
}

export interface RouterContext {
  config: ClawConfig;
  baseUrl: string;
  token: string;
  sessions: SessionStore;
  recordHandlerCall(
    name: HandlerName,
    result: "ok" | "error",
    durationMs: number,
    error?: string,
  ): void;
}

export async function routeMessage(
  ctx: RouterContext,
  message: WeixinMessage,
): Promise<void> {
  if (message.message_type === 2) return;
  const fromUserId = message.from_user_id?.trim();
  if (!fromUserId) return;
  const text = extractText(message);
  if (!text) return;

  const session = ctx.sessions.get(fromUserId);
  const inCtxd = session?.activeMode === "ctxd";
  const trimmed = text.trim();
  const contextToken = message.context_token;

  if (trimmed === CMD_ENTER_CTXD) {
    await ctx.sessions.put(fromUserId, { activeMode: "ctxd", lastActivity: new Date().toISOString() });
    const reply = inCtxd
      ? "已在 ctxd 模式。粘贴 Slack URL 开始，/q 退出。"
      : "已进入 ctxd 模式。粘贴 Slack URL 开始，/r 清上下文，/q 退出。";
    await sendText(ctx, fromUserId, reply, contextToken);
    logLine("cmd", fromUserId, trimmed, "enter-ctxd");
    return;
  }

  if (trimmed === CMD_EXIT) {
    if (inCtxd) {
      await ctx.sessions.put(fromUserId, { activeMode: null, lastActivity: new Date().toISOString() });
      await sendText(ctx, fromUserId, "已退出 ctxd 模式。", contextToken);
      logLine("cmd", fromUserId, trimmed, "exit-ctxd");
    } else {
      await sendText(ctx, fromUserId, "当前不在 ctxd 模式。", contextToken);
      logLine("cmd", fromUserId, trimmed, "exit-noop");
    }
    return;
  }

  if (trimmed === CMD_RESET) {
    if (!inCtxd) {
      await sendText(ctx, fromUserId, "当前不在 ctxd 模式。", contextToken);
      logLine("cmd", fromUserId, trimmed, "reset-not-in-mode");
      return;
    }
    await handleCtxd(ctx, fromUserId, "/reset", contextToken);
    await touchSession(ctx, fromUserId, session);
    return;
  }

  if (inCtxd) {
    await handleCtxd(ctx, fromUserId, text, contextToken);
    await touchSession(ctx, fromUserId, session);
    return;
  }

  if (looksLikeWordLookup(text)) {
    await handleKatakana(ctx, fromUserId, text, contextToken);
  } else {
    await sendText(ctx, fromUserId, `echo: ${text}`, contextToken);
    logLine("echo", fromUserId, text, "echo");
  }
  await touchSession(ctx, fromUserId, session);
}

async function touchSession(
  ctx: RouterContext,
  userId: string,
  prev: ClawSession | undefined,
): Promise<void> {
  await ctx.sessions.put(userId, {
    activeMode: prev?.activeMode ?? null,
    lastActivity: new Date().toISOString(),
  });
}

async function sendText(
  ctx: RouterContext,
  toUserId: string,
  text: string,
  contextToken: string | undefined,
): Promise<void> {
  await sendTextMessage({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    toUserId,
    text,
    contextToken,
    botAgent: ctx.config.botAgent,
  });
}

async function handleKatakana(
  ctx: RouterContext,
  fromUserId: string,
  text: string,
  contextToken: string | undefined,
): Promise<void> {
  if (!ctx.config.workers.katakana || !ctx.config.workerSecret) {
    const msg = "katakana 未配置：缺 WORKER_URL_KATAKANA 或 CLAW_WORKER_SECRET";
    await sendText(ctx, fromUserId, msg, contextToken);
    ctx.recordHandlerCall("katakana", "error", 0, "not configured");
    logLine("katakana", fromUserId, text, "not configured");
    return;
  }
  const t0 = Date.now();
  const result = await callKatakana(
    { workerUrl: ctx.config.workers.katakana, secret: ctx.config.workerSecret },
    fromUserId,
    text,
  );
  const ms = Date.now() - t0;
  await sendText(ctx, fromUserId, result.text || "(空响应)", contextToken);
  ctx.recordHandlerCall("katakana", result.ok ? "ok" : "error", ms, result.ok ? undefined : result.text);
  logLine("katakana", fromUserId, text, result.ok ? "ok" : `error: ${result.text}`, ms);
}

async function handleCtxd(
  ctx: RouterContext,
  fromUserId: string,
  text: string,
  contextToken: string | undefined,
): Promise<void> {
  if (!ctx.config.workers.ctxd || !ctx.config.workerSecret) {
    const msg = "ctxd 未配置：缺 WORKER_URL_CTXD 或 CLAW_WORKER_SECRET";
    await sendText(ctx, fromUserId, msg, contextToken);
    ctx.recordHandlerCall("ctxd", "error", 0, "not configured");
    logLine("ctxd", fromUserId, text, "not configured");
    return;
  }
  const t0 = Date.now();
  const result = await callCtxd(
    { workerUrl: ctx.config.workers.ctxd, secret: ctx.config.workerSecret },
    fromUserId,
    text,
  );
  const ms = Date.now() - t0;
  await sendText(ctx, fromUserId, result.text || "(空响应)", contextToken);
  ctx.recordHandlerCall("ctxd", result.ok ? "ok" : "error", ms, result.ok ? undefined : result.text);
  logLine("ctxd", fromUserId, text, result.ok ? "ok" : `error: ${result.text}`, ms);
}
