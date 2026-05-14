import { mkdir } from "node:fs/promises";

import { loadConfig } from "./config.ts";
import { SessionStore } from "./sessions.ts";
import { ClawState } from "./state.ts";
import { startWebServer } from "./web/server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });

  const sessions = new SessionStore(config.sessionsPath);
  await sessions.load();

  const state = new ClawState(config, sessions);
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
