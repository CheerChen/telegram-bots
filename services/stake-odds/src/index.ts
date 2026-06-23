import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";

import { loadConfig } from "./config.ts";
import { runCycle } from "./monitor.ts";
import { CallbackPoller } from "./polling.ts";
import { StateStore } from "./state.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function randomJitter(maxMs: number): number {
  if (maxMs <= 0) return 0;
  return Math.floor(Math.random() * maxMs);
}

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  const store = new StateStore(config.statePath);

  // /healthz — lightweight liveness probe for Docker HEALTHCHECK.
  const server = createServer((req, res) => {
    if (req.method === "GET" && new URL(req.url ?? "/", "http://localhost").pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "stake-odds" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  log(`stake-odds listening on http://${config.host}:${config.port}`);
  log(`data dir: ${config.dataDir}`);
  log(
    `poll every ${config.pollIntervalMs}ms (jitter 0..${config.jitterMaxMs}ms), ` +
      `threshold ${(config.oddsChangeThreshold * 100).toFixed(0)}%, ` +
      `keywords: ${config.tournamentKeywords.join(", ") || "<none>"}`,
  );

  // Long-poll Telegram for callback_query acks so inline keyboard buttons
  // (display-only) don't spin/timeout when tapped.
  const poller = new CallbackPoller(config.telegramBotToken, log);
  poller.start();
  log("telegram callback polling started");

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      log("previous cycle still running, skipping tick");
      return;
    }
    running = true;
    const jitter = randomJitter(config.jitterMaxMs);
    if (jitter > 0) {
      await new Promise((r) => setTimeout(r, jitter));
    }
    try {
      const stats = await runCycle(config, store);
      const summary = [
        `league=${stats.league ?? "-"}`,
        `watched=${stats.watched}`,
        `live=${stats.live}`,
        `finished=${stats.finished}`,
        `seeded=${stats.seeded}`,
        `edited=${stats.edited}`,
        `notified=${stats.notified}`,
        `idle=${stats.idle}`,
        `credAlert=${stats.credentialAlert}`,
      ];
      if (stats.errors.length) summary.push(`errors=${stats.errors.length}`);
      log(`cycle done: ${summary.join(" ")}`);
      for (const err of stats.errors) log(`  ! ${err}`);
    } catch (err) {
      log(`cycle crashed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  // Recursive setTimeout so cycles never overlap and jitter is natural.
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
    poller.stop();
    server.close(() => process.exit(0));
    // Force-exit after 5s if server.close hangs.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
