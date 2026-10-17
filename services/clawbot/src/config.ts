import { resolve } from "node:path";

export interface ClawConfig {
  port: number;
  host: string;
  dataDir: string;
  tokenPath: string;
  heartbeatPath: string;
  sessionDir: string;
  captureDir: string;
  mediaDir: string;
  botType: string | undefined;
  botAgent: string;
  // Model pool: comma-separated API keys. The pool auto-discovers available
  // models from the DashScope catalog at startup.
  llmApiKeys: string[];
  // Override the DashScope API base (for non-intl endpoints).
  llmApiBaseUrl: string;
  llmCompatBaseUrl: string;
  alertTelegramBotToken: string | undefined;
  alertTelegramChatId: string | undefined;
  uiUrl: string;
  // linesticker-bot Worker; LINE sticker links bypass the LLM when both are set.
  linestickerUrl: string | undefined;
  linestickerSecret: string | undefined;
}

export function loadConfig(): ClawConfig {
  const dataDir = resolve(process.env.CLAW_DATA_DIR?.trim() || "./data");
  return {
    port: parseInt(process.env.CLAW_PORT?.trim() || "8080", 10),
    host: process.env.CLAW_HOST?.trim() || "0.0.0.0",
    dataDir,
    tokenPath: resolve(dataDir, "token.json"),
    heartbeatPath: resolve(dataDir, "heartbeat"),
    sessionDir: resolve(dataDir, "sessions"),
    captureDir: resolve(dataDir, "captures"),
    mediaDir: resolve(dataDir, "media"),
    botType: process.env.ILINK_BOT_TYPE?.trim() || undefined,
    botAgent: process.env.CLAW_BOT_AGENT?.trim() || "clawbot/0.1.0",
    llmApiKeys: (process.env.LLM_API_KEYS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    llmApiBaseUrl: process.env.LLM_API_BASE_URL?.trim() || "https://dashscope-intl.aliyuncs.com",
    llmCompatBaseUrl:
      process.env.LLM_COMPAT_BASE_URL?.trim() ||
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    alertTelegramBotToken: process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim() || undefined,
    alertTelegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID?.trim() || undefined,
    uiUrl: process.env.CLAW_UI_URL?.trim() || "http://pi:8765",
    linestickerUrl: process.env.LINESTICKER_URL?.trim().replace(/\/+$/, "") || undefined,
    linestickerSecret: process.env.LINESTICKER_SECRET?.trim() || undefined,
  };
}
