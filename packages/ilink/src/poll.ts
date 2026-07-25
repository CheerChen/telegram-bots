import { getUpdates } from "./protocol.ts";
import type { GetUpdatesResponse, WeixinMessage } from "./types.ts";

export const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const DEFAULT_CLIENT_POLL_TIMEOUT_MS = 40_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export type PollExit =
  | { reason: "aborted" }
  | { reason: "session-expired"; errcode: number; errmsg?: string };

export interface PollLoopOptions {
  baseUrl: string;
  token: string;
  initialBuf?: string;
  botAgent?: string;
  signal: AbortSignal;
  onMessage(msg: WeixinMessage, ctx: { baseUrl: string; token: string }): void | Promise<void>;
  onBufUpdate(buf: string): void | Promise<void>;
  onError?(err: unknown, consecutiveFailures: number): void;
  /** Called after every successful getupdates round-trip, including empty ones. */
  onCycle?(): void;
}

export async function runPollLoop(opts: PollLoopOptions): Promise<PollExit> {
  let getUpdatesBuf = opts.initialBuf ?? "";
  let nextTimeoutMs = DEFAULT_CLIENT_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!opts.signal.aborted) {
    try {
      const resp: GetUpdatesResponse = await getUpdates({
        baseUrl: opts.baseUrl,
        token: opts.token,
        getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        botAgent: opts.botAgent,
        signal: opts.signal,
      });

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms + 5_000;
      }

      if (isApiError(resp)) {
        const errcode = resp.errcode ?? resp.ret ?? 0;
        if (errcode === SESSION_EXPIRED_ERRCODE) {
          return { reason: "session-expired", errcode, errmsg: resp.errmsg };
        }
        consecutiveFailures += 1;
        opts.onError?.(
          new Error(
            `getupdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
          ),
          consecutiveFailures,
        );
        await delayAfterFailure(consecutiveFailures, opts.signal);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        continue;
      }

      consecutiveFailures = 0;
      opts.onCycle?.();
      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        await opts.onBufUpdate(getUpdatesBuf);
      }

      for (const message of resp.msgs ?? []) {
        if (opts.signal.aborted) break;
        await opts.onMessage(message, { baseUrl: opts.baseUrl, token: opts.token });
      }
    } catch (err) {
      if (opts.signal.aborted) break;
      consecutiveFailures += 1;
      opts.onError?.(err, consecutiveFailures);
      await delayAfterFailure(consecutiveFailures, opts.signal);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
    }
  }

  return { reason: "aborted" };
}

function isApiError(resp: GetUpdatesResponse): boolean {
  return (resp.ret !== undefined && resp.ret !== 0) ||
    (resp.errcode !== undefined && resp.errcode !== 0);
}

function delayAfterFailure(consecutiveFailures: number, signal: AbortSignal): Promise<void> {
  const ms = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
