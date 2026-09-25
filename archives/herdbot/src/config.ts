import { resolve } from "node:path";

export interface HerdConfig {
  // Telegram
  telegramBotToken: string;
  allowedChatId: string;
  // Agent SDK — supports Anthropic API or DashScope's Anthropic-compatible endpoint.
  // When using DashScope: ANTHROPIC_AUTH_TOKEN holds the DashScope key,
  // ANTHROPIC_API_KEY must be empty, and ANTHROPIC_BASE_URL points at /apps/anthropic.
  anthropicApiKey: string;
  anthropicAuthToken: string | undefined;
  anthropicBaseUrl: string | undefined;
  claudeModel: string | undefined;
  // ctxd binary
  ctxdBin: string;
  // ctxd credentials (passed to the subprocess as env)
  githubToken: string | undefined;
  slackToken: string | undefined;
  atlassianBaseUrl: string | undefined;
  atlassianEmail: string | undefined;
  atlassianApiToken: string | undefined;
  // Persistence
  dataDir: string;
  sessionDir: string;
  // Session control
  idleTimeoutMs: number;
  // Local system prompt overlay (gitignored, Pi-only)
  localPromptPath: string;
  // External skill docs loaded into the system prompt at runtime.
  // Points to the ctxd SKILL.md so the agent knows how to use ctxd
  // without hardcoding the usage in source.
  ctxdSkillPath: string;
  // Owner alerting — reuses the same bot token, sends to allowedChatId.
  alertChatId: string;
}

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

export function loadConfig(): HerdConfig {
  const dataDir = resolve(process.env.HERD_DATA_DIR?.trim() || "./data");
  return {
    telegramBotToken: req("TELEGRAM_BOT_TOKEN"),
    allowedChatId: req("ALLOWED_CHAT_ID"),
    // ANTHROPIC_API_KEY is required by the SDK even when using DashScope
    // (set to empty string in that case — the SDK checks for its presence).
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    claudeModel: process.env.CLAUDE_MODEL?.trim() || undefined,
    ctxdBin: process.env.CTXD_BIN?.trim() || "ctxd",
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
    slackToken: process.env.SLACK_TOKEN?.trim() || undefined,
    atlassianBaseUrl: process.env.ATLASSIAN_BASE_URL?.trim() || undefined,
    atlassianEmail: process.env.ATLASSIAN_EMAIL?.trim() || undefined,
    atlassianApiToken: process.env.ATLASSIAN_API_TOKEN?.trim() || undefined,
    dataDir,
    sessionDir: resolve(dataDir, "sessions"),
    idleTimeoutMs: parseInt(process.env.HERD_IDLE_TIMEOUT_MS?.trim() || "7200000", 10),
    localPromptPath: resolve(dataDir, "herdbot.local.md"),
    ctxdSkillPath: process.env.CTXD_SKILL_PATH?.trim() || resolve(dataDir, "ctxd-SKILL.md"),
    alertChatId: process.env.ALERT_CHAT_ID?.trim() || req("ALLOWED_CHAT_ID"),
  };
}

/**
 * Build the env object handed to the ctxd subprocess.
 * Only keys that have values are included so ctxd falls back to its own
 * config file for anything we don't manage.
 */
export function ctxdEnv(config: HerdConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.githubToken) env.GITHUB_TOKEN = config.githubToken;
  if (config.slackToken) env.SLACK_TOKEN = config.slackToken;
  if (config.atlassianBaseUrl) env.CONFLUENCE_BASE_URL = config.atlassianBaseUrl;
  if (config.atlassianEmail) env.CONFLUENCE_EMAIL = config.atlassianEmail;
  if (config.atlassianApiToken) env.CONFLUENCE_API_TOKEN = config.atlassianApiToken;
  return env;
}
