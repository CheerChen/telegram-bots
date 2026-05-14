import { randomBytes } from "node:crypto";

import type {
  GetUpdatesResponse,
  QRCodeResponse,
  QRStatusResponse,
  WeixinMessage,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_BOT_TYPE = "3";
export const PROTOCOL_SOURCE_VERSION = "2.4.3";

const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = buildClientVersion(PROTOCOL_SOURCE_VERSION);
const DEFAULT_BOT_AGENT = `ilink/${PROTOCOL_SOURCE_VERSION}`;

export function normalizeBaseUrl(baseurl?: string): string {
  const value = baseurl?.trim();
  if (!value) {
    return DEFAULT_BASE_URL;
  }
  const withScheme = value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

export async function getBotQRCode(opts: {
  botType?: string;
  localTokenList?: string[];
  botAgent?: string;
} = {}): Promise<QRCodeResponse> {
  return postJson<QRCodeResponse>({
    baseUrl: DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(opts.botType ?? DEFAULT_BOT_TYPE)}`,
    body: {
      local_token_list: opts.localTokenList ?? [],
    },
    timeoutMs: 15_000,
    botAgent: opts.botAgent,
  });
}

export async function getQRCodeStatus(opts: {
  baseUrl?: string;
  qrcode: string;
  verifyCode?: string;
  timeoutMs?: number;
}): Promise<QRStatusResponse> {
  const params = new URLSearchParams({ qrcode: opts.qrcode });
  if (opts.verifyCode?.trim()) {
    params.set("verify_code", opts.verifyCode.trim());
  }
  return getJson<QRStatusResponse>({
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_qrcode_status?${params.toString()}`,
    timeoutMs: opts.timeoutMs ?? 35_000,
  });
}

export async function getUpdates(opts: {
  baseUrl: string;
  token: string;
  getUpdatesBuf: string;
  timeoutMs?: number;
  botAgent?: string;
  signal?: AbortSignal;
}): Promise<GetUpdatesResponse> {
  try {
    return await postJson<GetUpdatesResponse>({
      baseUrl: opts.baseUrl,
      endpoint: "ilink/bot/getupdates",
      token: opts.token,
      body: {
        get_updates_buf: opts.getUpdatesBuf,
        base_info: buildBaseInfo(opts.botAgent),
      },
      timeoutMs: opts.timeoutMs ?? 40_000,
      botAgent: opts.botAgent,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: opts.getUpdatesBuf,
      };
    }
    throw err;
  }
}

export async function sendTextMessage(opts: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
  botAgent?: string;
}): Promise<void> {
  await postJson<unknown>({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: opts.toUserId,
        client_id: generateClientId(opts.botAgent),
        message_type: 2,
        message_state: 2,
        item_list: [
          {
            type: 1,
            text_item: {
              text: opts.text,
            },
          },
        ],
        context_token: opts.contextToken || undefined,
      },
      base_info: buildBaseInfo(opts.botAgent),
    },
    timeoutMs: 15_000,
    botAgent: opts.botAgent,
  });
}

export function extractText(message: WeixinMessage): string {
  return (message.item_list ?? [])
    .filter((item) => item.type === 1 && item.text_item?.text)
    .map((item) => item.text_item?.text ?? "")
    .join("\n")
    .trim();
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function buildBaseInfo(botAgent?: string): Record<string, string> {
  return {
    channel_version: PROTOCOL_SOURCE_VERSION,
    bot_agent: botAgent ?? DEFAULT_BOT_AGENT,
  };
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildPostHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
    ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
  };
}

function generateClientId(botAgent?: string): string {
  const prefix = (botAgent ?? DEFAULT_BOT_AGENT).split("/")[0] || "ilink";
  return `${prefix}:${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function getJson<T>(opts: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
}): Promise<T> {
  return requestJson<T>({
    method: "GET",
    baseUrl: opts.baseUrl,
    endpoint: opts.endpoint,
    headers: buildCommonHeaders(),
    timeoutMs: opts.timeoutMs,
  });
}

async function postJson<T>(opts: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  timeoutMs?: number;
  botAgent?: string;
  signal?: AbortSignal;
}): Promise<T> {
  return requestJson<T>({
    method: "POST",
    baseUrl: opts.baseUrl,
    endpoint: opts.endpoint,
    headers: buildPostHeaders(opts.token),
    body: JSON.stringify(opts.body),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
}

async function requestJson<T>(opts: {
  method: "GET" | "POST";
  baseUrl: string;
  endpoint: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  const url = new URL(opts.endpoint, base);
  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  const linkedAbort = opts.signal
    ? (() => {
        const onAbort = () => controller?.abort();
        if (opts.signal.aborted) controller?.abort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
        return () => opts.signal?.removeEventListener("abort", onAbort);
      })()
    : undefined;
  try {
    const response = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: controller?.signal ?? opts.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${opts.method} ${url.pathname} HTTP ${response.status}: ${raw}`);
    }
    return (raw ? JSON.parse(raw) : {}) as T;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    linkedAbort?.();
  }
}
