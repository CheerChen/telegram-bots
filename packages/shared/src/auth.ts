import type { TelegramUpdate } from "./types.ts";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export function verifyWebhookSecret(req: Request, expected: string): boolean {
  return req.headers.get(SECRET_HEADER) === expected;
}

export function isAllowedChat(update: TelegramUpdate, allowedChatId: string): boolean {
  const chatId =
    update.message?.chat.id ??
    update.edited_message?.chat.id ??
    update.callback_query?.message?.chat.id;
  return chatId !== undefined && String(chatId) === allowedChatId;
}
