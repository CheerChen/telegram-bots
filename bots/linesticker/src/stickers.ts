// Telegram sticker-set Bot API calls. Runs in both the Worker and the
// GitHub Actions import script (Node), so stick to fetch / FormData / Blob.
import type { InlineKeyboardMarkup } from "shared/telegram";

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`telegram ${method} ${code}: ${description.slice(0, 200)}`);
  }
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | FormData,
  timeoutMs = 60_000,
): Promise<T> {
  const init: RequestInit =
    body instanceof FormData
      ? { method: "POST", body }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as ApiResponse<T>;
  if (!json.ok) {
    throw new TelegramError(
      method,
      json.error_code ?? res.status,
      json.description ?? "",
      json.parameters?.retry_after,
    );
  }
  return json.result as T;
}

export async function getBotUsername(token: string): Promise<string> {
  const me = await call<{ username: string }>(token, "getMe", {});
  return me.username;
}

export interface StickerSet {
  name: string;
  title: string;
  stickers: { file_id: string }[];
}

export async function getStickerSet(token: string, name: string): Promise<StickerSet | null> {
  try {
    return await call<StickerSet>(token, "getStickerSet", { name });
  } catch (e) {
    if (e instanceof TelegramError && e.code === 400) return null; // STICKERSET_INVALID
    throw e;
  }
}

export type StickerFormat = "static" | "video";

export interface StickerFile {
  data: Uint8Array<ArrayBuffer>;
  format: StickerFormat;
}

const DEFAULT_EMOJI = ["⭐"];

function attach(form: FormData, key: string, file: StickerFile): Record<string, unknown> {
  const [mime, ext] = file.format === "video" ? ["video/webm", "webm"] : ["image/png", "png"];
  form.append(key, new Blob([file.data], { type: mime }), `${key}.${ext}`);
  return { sticker: `attach://${key}`, format: file.format, emoji_list: DEFAULT_EMOJI };
}

// Telegram's cap for a regular sticker set.
export const SET_MAX = 120;

// createNewStickerSet takes 1..50 stickers in one call.
export const CREATE_BATCH_MAX = 50;

export async function createNewStickerSet(
  token: string,
  opts: { userId: string; name: string; title: string; stickers: StickerFile[] },
): Promise<void> {
  const form = new FormData();
  form.append("user_id", opts.userId);
  form.append("name", opts.name);
  form.append("title", opts.title);
  const inputs = opts.stickers.map((s, i) => attach(form, `s${i}`, s));
  form.append("stickers", JSON.stringify(inputs));
  await call(token, "createNewStickerSet", form, 300_000);
}

export async function addStickerToSet(
  token: string,
  opts: { userId: string; name: string; sticker: StickerFile },
): Promise<void> {
  const form = new FormData();
  form.append("user_id", opts.userId);
  form.append("name", opts.name);
  form.append("sticker", JSON.stringify(attach(form, "s0", opts.sticker)));
  await call(token, "addStickerToSet", form);
}

export async function sendSticker(
  token: string,
  opts: { chatId: string | number; fileId: string; replyMarkup?: InlineKeyboardMarkup },
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: opts.chatId, sticker: opts.fileId };
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
  await call(token, "sendSticker", body);
}

export function addSetKeyboard(url: string, title: string, count: number): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: `➕ ${title} (${count})`, url }]] };
}
