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

export async function allowChatIdWithCap(
  chatId: string,
  kv: KVNamespace,
  maxChats: number,
): Promise<boolean> {
  const key = `chat:${chatId}`;
  if (await kv.get(key)) return true;

  const countRaw = await kv.get("meta:count");
  const count = countRaw ? parseInt(countRaw, 10) : 0;
  if (count >= maxChats) return false;

  await kv.put(key, "1");
  await kv.put("meta:count", String(count + 1));
  return true;
}

export async function allowChatWithCap(
  update: TelegramUpdate,
  kv: KVNamespace,
  maxChats: number,
): Promise<boolean> {
  const chat =
    update.message?.chat ??
    update.edited_message?.chat ??
    update.callback_query?.message?.chat;
  if (!chat || chat.type !== "private") return false;
  return allowChatIdWithCap(String(chat.id), kv, maxChats);
}
