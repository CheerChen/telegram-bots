import { resolve } from "node:path";

export interface StakeOddsConfig {
  // HTTP server
  port: number;
  host: string;
  dataDir: string;
  statePath: string;

  // Telegram
  telegramBotToken: string;
  telegramChatId: string;
  telegramMessageThreadId: number | undefined;

  // Stake credentials
  accessToken: string;
  cfClearance: string;
  userAgent: string;
  sessionCookie: string | undefined;
  acceptLanguage: string;
  xLanguage: string;

  // Stake request
  sportSlug: string;
  group: string;

  // Monitoring behaviour
  tournamentKeywords: string[];
  oddsChangeThreshold: number;
  pollIntervalMs: number;
  jitterMaxMs: number;
  credentialAlertCooldownMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(): StakeOddsConfig {
  const dataDir = resolve(process.env.STAKE_ODDS_DATA_DIR?.trim() || "./data");
  return {
    port: parseInt(optional("STAKE_ODDS_PORT", "8080"), 10),
    host: optional("STAKE_ODDS_HOST", "0.0.0.0"),
    dataDir,
    statePath: resolve(dataDir, "state.json"),

    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
    telegramMessageThreadId: (() => {
      const v = process.env.TELEGRAM_MESSAGE_THREAD_ID?.trim();
      return v ? parseInt(v, 10) : undefined;
    })(),

    accessToken: required("STAKE_ACCESS_TOKEN"),
    cfClearance: required("STAKE_CF_CLEARANCE"),
    userAgent: required("STAKE_USER_AGENT"),
    sessionCookie: process.env.STAKE_SESSION_COOKIE?.trim() || undefined,
    acceptLanguage: optional("STAKE_ACCEPT_LANGUAGE", "zh-CN,zh;q=0.9"),
    xLanguage: optional("STAKE_X_LANGUAGE", "zh"),

    sportSlug: optional("SPORT_SLUG", "soccer"),
    group: optional("GROUP", "threeway"),

    tournamentKeywords: csv(optional("TOURNAMENT_KEYWORD", "world cup,世界杯,fifa")),
    oddsChangeThreshold: parseFloat(optional("ODDS_CHANGE_THRESHOLD", "0.10")),
    pollIntervalMs: parseInt(optional("POLL_INTERVAL_MS", "600000"), 10),
    jitterMaxMs: parseInt(optional("JITTER_MAX_MS", "90000"), 10),
    credentialAlertCooldownMs: parseInt(optional("CREDENTIAL_ALERT_COOLDOWN_MS", "3600000"), 10),
  };
}
