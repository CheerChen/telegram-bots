import { resolve } from "node:path";

export interface PokemonStockConfig {
  // HTTP server
  port: number;
  host: string;
  dataDir: string;
  statePath: string;

  // Telegram
  telegramBotToken: string;
  telegramChatId: string;
  telegramMessageThreadId: number | undefined;

  // Pokémon Center auth — optional. Anonymous access can still read
  // product page stock signals; login cookie only matters for purchasing.
  cookie: string | undefined;
  userAgent: string;

  // Monitoring targets
  targets: string[];

  // Polling behaviour
  pollIntervalMs: number;
  interProductDelayMs: number;
  monitorAlertCooldownMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** Parse POKEMON_TARGETS — comma or newline separated URLs. */
function parseTargets(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

export function loadConfig(): PokemonStockConfig {
  const dataDir = resolve(process.env.POKEMON_STOCK_DATA_DIR?.trim() || "./data");
  return {
    port: parseInt(optional("POKEMON_STOCK_PORT", "8080"), 10),
    host: optional("POKEMON_STOCK_HOST", "0.0.0.0"),
    dataDir,
    statePath: resolve(dataDir, "state.json"),

    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
    telegramMessageThreadId: (() => {
      const v = process.env.TELEGRAM_MESSAGE_THREAD_ID?.trim();
      return v ? parseInt(v, 10) : undefined;
    })(),

    cookie: process.env.POKEMON_COOKIE?.trim() || undefined,
    userAgent: optional(
      "POKEMON_USER_AGENT",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    ),

    targets: parseTargets(required("POKEMON_TARGETS")),

    pollIntervalMs: parseInt(optional("POKEMON_POLL_INTERVAL_MS", "300000"), 10),
    interProductDelayMs: parseInt(optional("POKEMON_INTER_PRODUCT_DELAY_MS", "2000"), 10),
    monitorAlertCooldownMs: parseInt(optional("POKEMON_MONITOR_ALERT_COOLDOWN_MS", "3600000"), 10),
  };
}
