import { resolve } from "node:path";

export interface ClawConfig {
  port: number;
  host: string;
  dataDir: string;
  tokenPath: string;
  heartbeatPath: string;
  botType: string | undefined;
  botAgent: string;
  workerSecret: string | undefined;
  workers: {
    ctxd: string | undefined;
  };
}

export function loadConfig(): ClawConfig {
  const dataDir = resolve(process.env.CLAW_DATA_DIR?.trim() || "./data");
  return {
    port: parseInt(process.env.CLAW_PORT?.trim() || "8080", 10),
    host: process.env.CLAW_HOST?.trim() || "0.0.0.0",
    dataDir,
    tokenPath: resolve(dataDir, "token.json"),
    heartbeatPath: resolve(dataDir, "heartbeat"),
    botType: process.env.ILINK_BOT_TYPE?.trim() || undefined,
    botAgent: process.env.CLAW_BOT_AGENT?.trim() || "clawbot/0.1.0",
    workerSecret: process.env.CLAW_WORKER_SECRET?.trim() || undefined,
    workers: {
      ctxd: process.env.WORKER_URL_CTXD?.trim() || undefined,
    },
  };
}
