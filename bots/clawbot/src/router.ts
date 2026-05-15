import { extractText, sendTextMessage } from "ilink/protocol";
import type { WeixinMessage } from "ilink/types";

import type { ClawConfig } from "./config.ts";
import { callCtxd } from "./handlers/ctxd.ts";
import type { HandlerName } from "./state.ts";

const LOG_TEXT_MAX = 80;

const CMD_ENTER_CTXD = "/c";
const CMD_EXIT = "/q";
const CMD_RESET = "/r";

function logLine(mode: string, from: string, text: string, result: string, ms?: number): void {
  const t = text.length > LOG_TEXT_MAX ? `${text.slice(0, LOG_TEXT_MAX)}…` : text;
  const duration = ms !== undefined ? ` ${ms}ms` : "";
  console.log(`[${mode}] from=${from} text=${JSON.stringify(t)} → ${result}${duration}`);
}

export interface RouterContext {
  config: ClawConfig;
  baseUrl: string;
  token: string;
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

  const trimmed = text.trim();
  const contextToken = message.context_token;

  if (trimmed === CMD_ENTER_CTXD) {
    await sendText(ctx, fromUserId, "已默认处于 ctxd 模式，请直接发送 Slack 链接。", contextToken);
    logLine("cmd", fromUserId, trimmed, "ctxd-default");
    return;
  }

  if (trimmed === CMD_EXIT) {
    await sendText(ctx, fromUserId, "当前只支持 ctxd，无法退出。", contextToken);
    logLine("cmd", fromUserId, trimmed, "exit-disabled");
    return;
  }

  if (trimmed === CMD_RESET) {
    await handleCtxd(ctx, fromUserId, "/reset", contextToken);
    return;
  }

  await handleCtxd(ctx, fromUserId, text, contextToken);
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
