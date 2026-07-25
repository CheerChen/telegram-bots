// Owner alerting via Telegram. Best-effort: never throws, no-op when the
// ALERT_TELEGRAM_* env vars are unset.

import type { ClawConfig } from "./config.ts";

export async function notifyOwner(config: ClawConfig, text: string): Promise<void> {
  const { alertTelegramBotToken, alertTelegramChatId } = config;
  if (!alertTelegramBotToken || !alertTelegramChatId) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${alertTelegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: alertTelegramChatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      console.error(`owner alert failed: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("owner alert failed", err);
  }
}
