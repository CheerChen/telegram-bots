import { spawn } from "node:child_process";

import type { HerdConfig } from "./config.ts";
import { ctxdEnv } from "./config.ts";

export class UnsupportedSourceError extends Error {
  constructor(url: string) {
    super(`unsupported source: ${url}`);
    this.name = "UnsupportedSourceError";
  }
}

export class CtxdAuthError extends Error {
  /** Which credential likely failed, derived from ctxd's stderr. */
  readonly credential: string;
  constructor(message: string, credential: string) {
    super(message);
    this.name = "CtxdAuthError";
    this.credential = credential;
  }
}

export interface CtxdResult {
  markdown: string;
  /** Exit code from ctxd. 0 = clean. */
  exitCode: number;
}

/**
 * Run `ctxd <url> -f md` and return the markdown dump.
 *
 * - stdout → markdown body
 * - stderr → parsed for auth failures (401/403) and unsupported URLs
 * - `--max-chars -1` so stdout is never truncated (Phase 1 sends the full
 *   dump as a file via sendDocument; the agent layer gets its own context
 *   through the SDK, not through this return value)
 */
export function runCtxd(config: HerdConfig, url: string): Promise<CtxdResult> {
  return new Promise((resolve, reject) => {
    const args = [url, "-f", "md", "--max-chars", "-1"];
    const proc = spawn(config.ctxdBin, args, {
      env: { ...process.env, ...ctxdEnv(config) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stderrText = "";

    proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on("data", (c: Buffer) => {
      stderrText += c.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`ctxd spawn failed: ${err.message}`));
    });

    proc.on("close", (code) => {
      const markdown = Buffer.concat(stdoutChunks).toString("utf8");

      if (stderrText.includes("Unsupported URL") || stderrText.includes("unsupported source")) {
        reject(new UnsupportedSourceError(url));
        return;
      }

      // ctxd prints auth remediation hints on 401/403. Detect the credential
      // from the hint so alert.ts can name it.
      if (code !== 0 && /40[13]/.test(stderrText)) {
        const cred = detectCredential(stderrText);
        reject(new CtxdAuthError(`ctxd auth failed: ${stderrText.trim().slice(0, 200)}`, cred));
        return;
      }

      if (code !== 0 && !markdown) {
        reject(new Error(`ctxd exit ${code}: ${stderrText.trim().slice(0, 300)}`));
        return;
      }

      resolve({ markdown, exitCode: code ?? 0 });
    });
  });
}

function detectCredential(stderr: string): string {
  if (/GITHUB_TOKEN/i.test(stderr)) return "GITHUB_TOKEN";
  if (/SLACK_TOKEN/i.test(stderr)) return "SLACK_TOKEN";
  if (/CONFLUENCE/i.test(stderr)) return "ATLASSIAN_API_TOKEN";
  return "unknown";
}
