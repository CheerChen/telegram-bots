const SIGNATURE_HEADER = "x-line-signature";

export interface LineMessage {
  type: string;
  text?: string;
}

export interface LineSource {
  type: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineEvent {
  type: string;
  replyToken?: string;
  source?: LineSource;
  message?: LineMessage;
  timestamp?: number;
}

export interface LineWebhook {
  destination: string;
  events: LineEvent[];
}

export async function verifyLineSignature(
  bodyText: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const computed = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return computed === signature;
}

export function getSignatureHeader(req: Request): string | null {
  return req.headers.get(SIGNATURE_HEADER);
}

export interface LineMessageOut {
  type: string;
  [k: string]: unknown;
}

export async function replyMessages(
  token: string,
  replyToken: string,
  messages: LineMessageOut[],
): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`line reply ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function replyText(
  token: string,
  replyToken: string,
  text: string,
): Promise<void> {
  return replyMessages(token, replyToken, [{ type: "text", text: text.slice(0, 5000) }]);
}

export async function pushText(token: string, userId: string, text: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: text.slice(0, 5000) }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`line push ${res.status}: ${detail.slice(0, 200)}`);
  }
}
