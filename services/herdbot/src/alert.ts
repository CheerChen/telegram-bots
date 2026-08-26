import { sendMessage } from "shared/telegram";

import type { HerdConfig } from "./config.ts";
import { CtxdAuthError } from "./ctxd.ts";

/**
 * Send an owner alert when a credential fails.
 *
 * herdbot is itself a Telegram bot, so it alerts the owner directly via
 * the same bot token — no separate alert bot needed (unlike clawbot which
 * needed a second bot because WeChat can't DM the owner).
 */
export async function alertAuthFailure(
  config: HerdConfig,
  err: CtxdAuthError,
): Promise<void> {
  const renewalHints: Record<string, string> = {
    GITHUB_TOKEN: "https://github.com/settings/tokens",
    SLACK_TOKEN: "https://api.slack.com/apps — 你的 app → OAuth & Permissions",
    ATLASSIAN_API_TOKEN: "https://id.atlassian.com/manage-profile/security/api-tokens",
    unknown: "检查 ctxd 配置",
  };

  const hint = renewalHints[err.credential] ?? renewalHints.unknown;
  const text = `⚠️ 凭据失效：${err.credential}\n\n${err.message.slice(0, 300)}\n\n续期入口：${hint}`;

  await sendMessage(config.telegramBotToken, {
    chatId: config.alertChatId,
    text,
    disableWebPagePreview: true,
  }).catch((e) => {
    // Alert failure must not crash the bot — log and move on.
    console.error("alert send failed", e);
  });
}
