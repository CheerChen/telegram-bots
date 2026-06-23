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
  llmBaseUrl: string | undefined;
  llmApiKey: string | undefined;
  llmModel: string | undefined;
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
    sessionDir: resolve(dataDir, "sessions"),
    captureDir: resolve(dataDir, "captures"),
    mediaDir: resolve(dataDir, "media"),
    botType: process.env.ILINK_BOT_TYPE?.trim() || undefined,
    botAgent: process.env.CLAW_BOT_AGENT?.trim() || "clawbot/0.1.0",
    llmBaseUrl: process.env.LLM_BASE_URL?.trim() || undefined,
    llmApiKey: process.env.LLM_API_KEY?.trim() || undefined,
    llmModel: process.env.LLM_MODEL?.trim() || undefined,
    workerSecret: process.env.CLAW_WORKER_SECRET?.trim() || undefined,
    workers: {
      ctxd: process.env.WORKER_URL_CTXD?.trim() || undefined,
    },
  };
}
