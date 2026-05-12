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

async function callApi(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`telegram ${method} ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function sendMessage(token: string, opts: SendMessageOptions): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
  };
  if (opts.replyToMessageId !== undefined) body.reply_to_message_id = opts.replyToMessageId;
  if (opts.disableWebPagePreview) body.disable_web_page_preview = true;
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
  await callApi(token, "sendMessage", body);
}

export async function editMessageText(token: string, opts: EditMessageTextOptions): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    message_id: opts.messageId,
    text: opts.text,
  };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.disableWebPagePreview) body.disable_web_page_preview = true;
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
  await callApi(token, "editMessageText", body);
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

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
