import { extractText, sendTextMessage } from "ilink/protocol";
import type { WeixinMessage } from "ilink/types";

import type { ClawConfig } from "./config.ts";
import {
  handleImageMessage,
  handleChatMessage,
  maybeCaptureStructuredMessage,
  resetChatSession,
} from "./handlers/chat.ts";
import type { HandlerName } from "./state.ts";

const LOG_TEXT_MAX = 80;
const BATCH_DELAY_MS = 2_500;

const CMD_HELP = "/help";
const CMD_RESET = "/r";
const CMD_RESET_LONG = "/reset";
const CMD_NEW = "/new";
const CMD_SWITCH_SESSION = "0";

interface PendingBatch {
  ctx: RouterContext;
  fromUserId: string;
  contextToken: string | undefined;
  texts: string[];
  timer: NodeJS.Timeout;
}

const pendingBatches = new Map<string, PendingBatch>();

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
  const contextToken = message.context_token;
  const capture = await maybeCaptureStructuredMessage(ctx.config, message, text);
  if (capture) {
    console.log(`[capture] from=${fromUserId} id=${capture.id} reason=${capture.reason} ${capture.summary}`);
  }
  if (!text) {
    const handledImage = await handleImageIfPresent(ctx, fromUserId, message, contextToken);
    if (handledImage) return;
    await sendText(
      ctx,
      fromUserId,
      "这条消息不是纯文本，我已经记下原始结构了。当前版本请先发文字消息。",
      contextToken,
    );
    ctx.recordHandlerCall("chat", "error", 0, capture ? `unsupported message captured as ${capture.id}` : "unsupported message");
    logLine("chat", fromUserId, "[non-text]", capture ? `unsupported:${capture.id}` : "unsupported");
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  if (trimmed === CMD_HELP) {
    await sendText(
      ctx,
      fromUserId,
      "直接发文字给我就行。我会短暂等待一批连续消息后再统一处理；回复过长时会自动拆成多条。发送 /r、/reset、/new 或 0 可以清空当前会话。",
      contextToken,
    );
    logLine("cmd", fromUserId, trimmed, "help");
    return;
  }

  if (
    trimmed === CMD_RESET ||
    trimmed === CMD_RESET_LONG ||
    trimmed === CMD_NEW ||
    trimmed === CMD_SWITCH_SESSION
  ) {
    clearPendingBatch(fromUserId);
    await resetChatSession(ctx.config, fromUserId);
    await sendText(ctx, fromUserId, "已清空当前会话。", contextToken);
    ctx.recordHandlerCall("chat", "ok", 0);
    logLine("cmd", fromUserId, trimmed, "reset");
    return;
  }

  scheduleChatBatch(ctx, fromUserId, text, contextToken);
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

async function sendMessages(
  ctx: RouterContext,
  toUserId: string,
  messages: string[],
  contextToken: string | undefined,
): Promise<void> {
  for (const message of messages) {
    await sendText(ctx, toUserId, message, contextToken);
  }
}

async function handleImageIfPresent(
  ctx: RouterContext,
  fromUserId: string,
  message: WeixinMessage,
  contextToken: string | undefined,
): Promise<boolean> {
  const hasImage = (message.item_list ?? []).some((item) => (item as { type?: number }).type === 2);
  if (!hasImage) return false;

  const t0 = Date.now();
  const result = await handleImageMessage(ctx.config, fromUserId, message);
  const ms = Date.now() - t0;
  await sendMessages(ctx, fromUserId, result.messages, contextToken);
  ctx.recordHandlerCall("chat", result.ok ? "ok" : "error", ms, result.error);
  logLine("image", fromUserId, "[image]", result.ok ? "ok" : `error: ${result.error}`, ms);
  return true;
}

function scheduleChatBatch(
  ctx: RouterContext,
  fromUserId: string,
  text: string,
  contextToken: string | undefined,
): void {
  const pending = pendingBatches.get(fromUserId);
  if (pending) {
    pending.texts.push(text.trim());
    pending.contextToken = contextToken ?? pending.contextToken;
    pending.ctx = ctx;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      void flushChatBatch(fromUserId);
    }, BATCH_DELAY_MS);
    logLine("batch", fromUserId, text, `queued:${pending.texts.length}`);
    return;
  }

  const timer = setTimeout(() => {
    void flushChatBatch(fromUserId);
  }, BATCH_DELAY_MS);
  pendingBatches.set(fromUserId, {
    ctx,
    fromUserId,
    contextToken,
    texts: [text.trim()],
    timer,
  });
  logLine("batch", fromUserId, text, "queued:1");
}

function clearPendingBatch(fromUserId: string): void {
  const pending = pendingBatches.get(fromUserId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingBatches.delete(fromUserId);
}

async function flushChatBatch(fromUserId: string): Promise<void> {
  const pending = pendingBatches.get(fromUserId);
  if (!pending) return;
  pendingBatches.delete(fromUserId);
  clearTimeout(pending.timer);

  const text = combineBatchTexts(pending.texts);
  await handleChat(pending.ctx, pending.fromUserId, text, pending.contextToken, pending.texts.length);
}

function combineBatchTexts(texts: string[]): string {
  if (texts.length <= 1) return texts[0] ?? "";
  return texts.join("\n\n");
}

async function handleChat(
  ctx: RouterContext,
  fromUserId: string,
  text: string,
  contextToken: string | undefined,
  batchSize = 1,
): Promise<void> {
  const t0 = Date.now();
  const result = await handleChatMessage(ctx.config, fromUserId, text);
  const ms = Date.now() - t0;
  await sendMessages(ctx, fromUserId, result.messages, contextToken);
  ctx.recordHandlerCall("chat", result.ok ? "ok" : "error", ms, result.error);
  logLine(
    "chat",
    fromUserId,
    text,
    result.ok ? `ok:${result.messages.length}:batch=${batchSize}` : `error: ${result.error}:batch=${batchSize}`,
    ms,
  );
}
