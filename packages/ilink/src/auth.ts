import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  PROTOCOL_SOURCE_VERSION,
  getBotQRCode,
  getQRCodeStatus,
  normalizeBaseUrl,
} from "./protocol.ts";
import type {
  LoginStatus,
  QRCodeResponse,
  QRStatusResponse,
  TokenFile,
} from "./types.ts";

const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;
const POLL_INTERVAL_MS = 1_000;

export interface AuthFlowOptions {
  botType?: string;
  existingTokens?: string[];
  loginTimeoutMs?: number;
  maxRefreshCount?: number;
  qrLongPollTimeoutMs?: number;
  botAgent?: string;
  signal?: AbortSignal;
  onQRCode(qr: QRCodeResponse, attempt: number): void | Promise<void>;
  onStatus(status: LoginStatus, info?: { baseUrl?: string }): void | Promise<void>;
  promptVerifyCode(): Promise<string>;
}

export type AuthFlowResult =
  | { kind: "confirmed"; token: TokenFile }
  | { kind: "reused-existing" };

export class AuthFlowError extends Error {}
export class AuthFlowAbortedError extends AuthFlowError {
  constructor() {
    super("auth flow aborted");
  }
}
export class AuthFlowTimeoutError extends AuthFlowError {
  constructor() {
    super("login timeout");
  }
}
export class AuthFlowQrLimitError extends AuthFlowError {
  constructor(limit: number) {
    super(`二维码刷新超过 ${limit} 次，停止登录`);
  }
}

export async function runAuthFlow(opts: AuthFlowOptions): Promise<AuthFlowResult> {
  const loginDeadline = Date.now() + (opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
  const maxRefresh = opts.maxRefreshCount ?? MAX_QR_REFRESH_COUNT;
  const pollTimeoutMs = opts.qrLongPollTimeoutMs ?? QR_LONG_POLL_TIMEOUT_MS;

  let refreshCount = 1;
  let qr = await fetchQR(opts, refreshCount);
  let pollingBaseUrl = DEFAULT_BASE_URL;
  let pendingVerifyCode: string | undefined;

  while (Date.now() < loginDeadline) {
    throwIfAborted(opts.signal);

    let status: QRStatusResponse;
    try {
      status = await getQRCodeStatus({
        baseUrl: pollingBaseUrl,
        qrcode: qr.qrcode,
        verifyCode: pendingVerifyCode,
        timeoutMs: pollTimeoutMs,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        status = { status: "wait" };
      } else {
        await opts.onStatus("wait");
        await sleep(POLL_INTERVAL_MS, opts.signal);
        continue;
      }
    }

    await opts.onStatus(status.status, { baseUrl: pollingBaseUrl });

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        pendingVerifyCode = undefined;
        break;
      case "need_verifycode":
        pendingVerifyCode = (await opts.promptVerifyCode()).trim();
        if (!pendingVerifyCode) {
          throw new AuthFlowError("empty verify code");
        }
        continue;
      case "verify_code_blocked":
        pendingVerifyCode = undefined;
        if (refreshCount >= maxRefresh) throw new AuthFlowQrLimitError(maxRefresh);
        qr = await fetchQR(opts, ++refreshCount);
        pollingBaseUrl = DEFAULT_BASE_URL;
        break;
      case "expired":
        if (refreshCount >= maxRefresh) throw new AuthFlowQrLimitError(maxRefresh);
        qr = await fetchQR(opts, ++refreshCount);
        pollingBaseUrl = DEFAULT_BASE_URL;
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          pollingBaseUrl = normalizeBaseUrl(status.redirect_host);
        }
        break;
      case "binded_redirect":
        return { kind: "reused-existing" };
      case "confirmed":
        return { kind: "confirmed", token: buildTokenFromConfirmed(status, pollingBaseUrl) };
      default:
        throw new AuthFlowError(`未知扫码状态: ${(status as QRStatusResponse).status}`);
    }

    await sleep(POLL_INTERVAL_MS, opts.signal);
  }

  throw new AuthFlowTimeoutError();
}

async function fetchQR(
  opts: AuthFlowOptions,
  attempt: number,
): Promise<QRCodeResponse> {
  const qr = await getBotQRCode({
    botType: opts.botType ?? DEFAULT_BOT_TYPE,
    localTokenList: opts.existingTokens ?? [],
    botAgent: opts.botAgent,
  });
  if (!qr.qrcode || !qr.qrcode_img_content) {
    throw new AuthFlowError(`get_bot_qrcode 返回缺少 qrcode 字段: ${JSON.stringify(qr)}`);
  }
  await opts.onQRCode(qr, attempt);
  return qr;
}

function buildTokenFromConfirmed(
  status: QRStatusResponse,
  pollingBaseUrl: string,
): TokenFile {
  if (!status.bot_token?.trim()) {
    throw new AuthFlowError("登录 confirmed，但响应里没有 bot_token");
  }
  if (!status.ilink_bot_id?.trim()) {
    throw new AuthFlowError("登录 confirmed，但响应里没有 ilink_bot_id");
  }
  return {
    bot_token: status.bot_token,
    ilink_bot_id: status.ilink_bot_id,
    baseurl: normalizeBaseUrl(status.baseurl || pollingBaseUrl),
    ilink_user_id: status.ilink_user_id,
    get_updates_buf: "",
    saved_at: new Date().toISOString(),
    protocol_source: `@tencent-weixin/openclaw-weixin@${PROTOCOL_SOURCE_VERSION}`,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthFlowAbortedError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AuthFlowAbortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AuthFlowAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
