import { mkdir } from "node:fs/promises";

import { loadConfig } from "./config.ts";
import { ClawState } from "./state.ts";
import { startWebServer } from "./web/server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(config.sessionDir, { recursive: true }),
    mkdir(config.captureDir, { recursive: true }),
    mkdir(config.mediaDir, { recursive: true }),
  ]);

  const state = new ClawState(config);
  const web = await startWebServer({ state, port: config.port, host: config.host });

  await state.boot();

  console.log(`clawbot listening on http://${config.host}:${config.port}`);
  console.log(`data dir: ${config.dataDir}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down…`);
    await state.stop();
    await web.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Backstop: a rejection escaping a fire-and-forget path (e.g. batched replies)
// must not take down the whole bridge with Node's default crash behavior.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
});

main().catch((err) => {
  console.error(err);
  // Hard-exit: the web server would otherwise keep a half-booted process
  // alive forever; exiting lets `restart: unless-stopped` retry properly.
  process.exit(1);
});
