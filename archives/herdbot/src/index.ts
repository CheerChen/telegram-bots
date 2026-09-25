import { mkdir } from "node:fs/promises";

import { loadConfig } from "./config.ts";
import { createBot } from "./bot.ts";
import { SessionStore } from "./session.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });

  const sessions = new SessionStore(config);
  await sessions.init();

  const bot = createBot({ config, sessions });

  console.log("herdbot starting (long polling)…");

  // Long polling — Pi initiates the connection, no inbound port needed.
  // bot.start() blocks until stopped, so register signal handlers first.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down…`);
    await bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.start({
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
