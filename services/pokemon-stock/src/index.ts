import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";

import { loadConfig } from "./config.ts";
import { runCycle } from "./monitor.ts";
import { StateStore } from "./state.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  const store = new StateStore(config.statePath);

  // /healthz — lightweight liveness probe for Docker HEALTHCHECK.
  const server = createServer((req, res) => {
    if (req.method === "GET" && new URL(req.url ?? "/", "http://localhost").pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "pokemon-stock" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  log(`pokemon-stock listening on http://${config.host}:${config.port}`);
  log(`data dir: ${config.dataDir}`);
  log(
    `poll every ${config.pollIntervalMs}ms, ` +
      `${config.targets.length} targets`,
  );

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      log("previous cycle still running, skipping tick");
      return;
    }
    running = true;
    try {
      const stats = await runCycle(config, store);
      const summary = [
        `checked=${stats.checked}`,
        `notified=${stats.notified}`,
        `failures=${stats.failures}`,
        `credAlert=${stats.monitorAlert}`,
      ];
      log(`cycle done: ${summary.join(" ")}`);
      for (const line of stats.logs) console.log(`  ${line}`);
    } catch (err) {
      log(`cycle crashed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  // Recursive setTimeout so cycles never overlap.
  const scheduleNext = (): void => {
    setTimeout(() => {
      void tick().finally(scheduleNext);
    }, config.pollIntervalMs);
  };

  // Kick off immediately on boot, then settle into the interval.
  void tick().finally(scheduleNext);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n${signal} received, shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
