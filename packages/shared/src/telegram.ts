export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

type ParseMode = "HTML" | "MarkdownV2";

export interface SendMessageOptions {
  chatId: number | string;
  text: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  disableWebPagePreview?: boolean;
  parseMode?: ParseMode;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface EditMessageTextOptions {
  chatId: number | string;
  messageId: number;
  text: string;
  parseMode?: ParseMode;
  disableWebPagePreview?: boolean;
  replyMarkup?: InlineKeyboardMarkup;
}

async function callApi<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`telegram ${method} ${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface SendMessageResponse {
  result?: { message_id: number };
}

export async function sendMessage(token: string, opts: SendMessageOptions): Promise<number> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
  };
  if (opts.replyToMessageId !== undefined) body.reply_to_message_id = opts.replyToMessageId;
  if (opts.messageThreadId !== undefined) body.message_thread_id = opts.messageThreadId;
  if (opts.disableWebPagePreview) body.disable_web_page_preview = true;
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
  const json = await callApi<SendMessageResponse>(token, "sendMessage", body);
  if (!json.result?.message_id) throw new Error("telegram sendMessage: no message_id");
  return json.result.message_id;
}

export async function editMessageText(token: string, opts: EditMessageTextOptions): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    message_id: opts.messageId,
    text: opts.text,
  };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.disableWebPagePreview) body.disable_web_page_preview = true;
  if (opts.replyMarkup !== undefined) body.reply_markup = opts.replyMarkup;
  await callApi(token, "editMessageText", body);
}

export interface SendVideoOptions {
  chatId: number | string;
  video: string;
  caption?: string;
  parseMode?: ParseMode;
  replyToMessageId?: number;
  supportsStreaming?: boolean;
}

export async function sendVideo(token: string, opts: SendVideoOptions): Promise<number> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    video: opts.video,
  };
  if (opts.caption) body.caption = opts.caption;
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.replyToMessageId !== undefined) body.reply_to_message_id = opts.replyToMessageId;
  if (opts.supportsStreaming) body.supports_streaming = true;
  const json = await callApi<SendMessageResponse>(token, "sendVideo", body);
  if (!json.result?.message_id) throw new Error("telegram sendVideo: no message_id");
  return json.result.message_id;
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  await callApi(token, "answerCallbackQuery", body);
}

export async function deleteMessage(
  token: string,
  chatId: number | string,
  messageId: number,
): Promise<void> {
  await callApi(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
