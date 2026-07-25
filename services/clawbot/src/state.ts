import { writeFile } from "node:fs/promises";

import { AuthFlowAbortedError, runAuthFlow } from "ilink/auth";
import { runPollLoop } from "ilink/poll";
import { normalizeBaseUrl } from "ilink/protocol";
import { readTokenFileIfExists, writeTokenFile } from "ilink/token-store";
import type { LoginStatus, QRCodeResponse, TokenFile } from "ilink/types";

import { notifyOwner } from "./alert.ts";
import type { ClawConfig } from "./config.ts";
import { routeMessage, type RouterContext } from "./router.ts";

export type ClawStatus = "auth-required" | "authing" | "running";
export type AuthReason = "initial" | "expired" | "manual-reset";
export type HandlerName = "chat";

export interface HandlerStats {
  configured: boolean;
  invocations: number;
  lastInvokedAt?: string;
  lastDurationMs?: number;
  lastResult?: "ok" | "error";
  lastError?: string;
}

export interface ClawSnapshot {
  status: ClawStatus;
  authReason: AuthReason;
  qrcode?: string;
  qrAttempt?: number;
  lastQrStatus?: LoginStatus;
  needVerifyCode?: boolean;
  authError?: string;
  botUserId?: string;
  pollSince?: string;
  lastPollAt?: string;
  lastPollError?: string;
  consecutiveFailures?: number;
  handlers?: Record<HandlerName, HandlerStats>;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class ClawState {
  private snapshot: ClawSnapshot = { status: "auth-required", authReason: "initial" };
  private token: TokenFile | undefined;
  private authAbort: AbortController | undefined;
  private verifyCodePromise:
    | { resolve: (code: string) => void; reject: (err: Error) => void }
    | undefined;
  private pollAbort: AbortController | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private handlerStats: Record<HandlerName, HandlerStats>;

  constructor(private readonly config: ClawConfig) {
    this.handlerStats = {
      chat: { configured: this.isHandlerConfigured("chat"), invocations: 0 },
    };
  }

  getSnapshot(): ClawSnapshot {
    return { ...this.snapshot, handlers: { ...this.handlerStats } };
  }

  recordHandlerCall(
    name: HandlerName,
    result: "ok" | "error",
    durationMs: number,
    error?: string,
  ): void {
    const prev = this.handlerStats[name];
    this.handlerStats = {
      ...this.handlerStats,
      [name]: {
        configured: prev.configured,
        invocations: prev.invocations + 1,
        lastInvokedAt: new Date().toISOString(),
        lastDurationMs: durationMs,
        lastResult: result,
        lastError: result === "error" ? error : undefined,
      },
    };
  }

  private isHandlerConfigured(name: HandlerName): boolean {
    if (name === "chat") {
      return Boolean(
        this.config.llmBaseUrl &&
        this.config.llmApiKey &&
        this.config.llmModel,
      );
    }
    return false;
  }

  async boot(): Promise<void> {
    const existing = await readTokenFileIfExists(this.config.tokenPath);
    if (existing) {
      this.token = existing;
      this.startPolling();
    }
  }

  startAuth(): { ok: boolean; error?: string } {
    if (this.snapshot.status !== "auth-required") {
      return { ok: false, error: `cannot start auth in status=${this.snapshot.status}` };
    }
    const reason = this.snapshot.authReason;
    this.snapshot = { status: "authing", authReason: reason };
    this.authAbort = new AbortController();
    void this.runAuth(reason);
    return { ok: true };
  }

  submitVerifyCode(code: string): { ok: boolean; error?: string } {
    if (!this.verifyCodePromise) return { ok: false, error: "no pending verify code" };
    const trimmed = code.trim();
    if (!trimmed) return { ok: false, error: "empty verify code" };
    this.verifyCodePromise.resolve(trimmed);
    this.verifyCodePromise = undefined;
    this.snapshot = { ...this.snapshot, needVerifyCode: false };
    return { ok: true };
  }

  cancelAuth(): void {
    this.authAbort?.abort();
    this.verifyCodePromise?.reject(new Error("cancelled"));
    this.verifyCodePromise = undefined;
    this.snapshot = {
      status: "auth-required",
      authReason: this.snapshot.authReason,
    };
  }

  async stop(): Promise<void> {
    this.authAbort?.abort();
    this.verifyCodePromise?.reject(new Error("shutting down"));
    this.verifyCodePromise = undefined;
    this.pollAbort?.abort();
    this.stopHeartbeat();
  }

  private async runAuth(reason: AuthReason): Promise<void> {
    const existingTokens = this.token?.bot_token ? [this.token.bot_token] : [];
    try {
      const result = await runAuthFlow({
        botType: this.config.botType,
        existingTokens,
        botAgent: this.config.botAgent,
        signal: this.authAbort?.signal,
        onQRCode: (qr: QRCodeResponse, attempt: number) => {
          this.snapshot = {
            ...this.snapshot,
            qrcode: qr.qrcode_img_content,
            qrAttempt: attempt,
            needVerifyCode: false,
            authError: undefined,
          };
        },
        onStatus: (status: LoginStatus) => {
          this.snapshot = { ...this.snapshot, lastQrStatus: status };
        },
        promptVerifyCode: () =>
          new Promise<string>((resolve, reject) => {
            this.snapshot = { ...this.snapshot, needVerifyCode: true };
            this.verifyCodePromise = { resolve, reject };
          }),
      });

      if (result.kind === "reused-existing") {
        if (!this.token) {
          this.snapshot = {
            status: "auth-required",
            authReason: "initial",
            authError: "服务端返回 binded_redirect，但本地没有 token",
          };
          return;
        }
      } else {
        this.token = result.token;
        await writeTokenFile(this.config.tokenPath, this.token);
      }
      this.startPolling();
    } catch (err) {
      if (err instanceof AuthFlowAbortedError) return;
      this.snapshot = {
        status: "auth-required",
        authReason: reason,
        authError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private startPolling(): void {
    if (!this.token) return;
    const baseUrl = normalizeBaseUrl(this.token.baseurl);
    this.snapshot = {
      status: "running",
      authReason: this.snapshot.authReason,
      botUserId: this.token.ilink_bot_id,
      pollSince: new Date().toISOString(),
    };
    this.pollAbort = new AbortController();
    this.startHeartbeat();
    void this.runPoll(baseUrl);
  }

  private async runPoll(baseUrl: string): Promise<void> {
    if (!this.token || !this.pollAbort) return;
    const ctx: RouterContext = {
      config: this.config,
      baseUrl,
      token: this.token.bot_token,
      recordHandlerCall: (name, result, durationMs, error) =>
        this.recordHandlerCall(name, result, durationMs, error),
    };

    const exit = await runPollLoop({
      baseUrl,
      token: this.token.bot_token,
      initialBuf: this.token.get_updates_buf ?? "",
      botAgent: this.config.botAgent,
      signal: this.pollAbort.signal,
      onBufUpdate: async (buf) => {
        if (!this.token) return;
        this.token = { ...this.token, get_updates_buf: buf };
        await writeTokenFile(this.config.tokenPath, this.token);
        this.snapshot = { ...this.snapshot, lastPollAt: new Date().toISOString() };
      },
      onMessage: async (message) => {
        try {
          await routeMessage(ctx, message);
        } catch (err) {
          console.error("router failed", err);
        }
      },
      onError: (err, consecutiveFailures) => {
        this.snapshot = {
          ...this.snapshot,
          lastPollError: err instanceof Error ? err.message : String(err),
          consecutiveFailures,
        };
      },
      // Fires on every successful round-trip (incl. empty long-polls), unlike
      // onBufUpdate — this is what /healthz uses as the liveness signal.
      onCycle: () => {
        this.snapshot = { ...this.snapshot, lastPollAt: new Date().toISOString() };
      },
    });

    this.stopHeartbeat();
    if (exit.reason === "session-expired") {
      this.token = undefined;
      this.snapshot = {
        status: "auth-required",
        authReason: "expired",
        authError: `session expired (errcode=${exit.errcode}${exit.errmsg ? `: ${exit.errmsg}` : ""})`,
      };
      void notifyOwner(
        this.config,
        `⚠️ clawbot: WeChat session expired (errcode=${exit.errcode}). ` +
          `Re-scan QR: ${this.config.uiUrl}`,
      );
    }
  }

  private startHeartbeat(): void {
    const tick = async () => {
      try {
        await writeFile(this.config.heartbeatPath, new Date().toISOString(), "utf-8");
      } catch (err) {
        console.error("heartbeat write failed", err);
      }
    };
    void tick();
    this.heartbeatTimer = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
