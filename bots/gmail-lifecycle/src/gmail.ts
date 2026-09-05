// Gmail API client for Cloudflare Workers.
//
// OAuth: Google does NOT rotate refresh tokens by default, so we store it in
// KV once (seeded via the local auth helper) and reuse it. The access token
// (1h lifetime) is cached in a module-level variable for the duration of a
// single Worker invocation.

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GmailEnv {
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_STATE: KVNamespace;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
  expires_in?: number;
}

// Cached access token for the current invocation.
let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0;

async function getAccessToken(env: GmailEnv): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && now < cachedTokenExpiry - 60_000) {
    return cachedAccessToken;
  }

  // Prefer KV-stored refresh token (in case it was rotated by a previous run).
  const kvRefresh = await env.GMAIL_STATE.get("gmail:refresh_token");
  const refreshToken = kvRefresh ?? env.GMAIL_REFRESH_TOKEN;

  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Gmail token refresh failed (${res.status}): ${data.error} ${data.error_description ?? ""}`,
    );
  }

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await env.GMAIL_STATE.put("gmail:refresh_token", data.refresh_token);
  }

  cachedAccessToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in ?? 3600) * 1000;
  return cachedAccessToken;
}

async function gmailFetch(
  env: GmailEnv,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getAccessToken(env);
  const url = path.startsWith("http") ? path : `${GMAIL_API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(30000),
  });
  if (res.status === 401) {
    // Token might be stale — clear cache and retry once.
    cachedAccessToken = null;
    cachedTokenExpiry = 0;
    const token2 = await getAccessToken(env);
    return fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token2}`,
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(30000),
    });
  }
  return res;
}

async function gmailJson<T>(
  env: GmailEnv,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await gmailFetch(env, path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gmail API ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Types (subset of Gmail API responses we use)
// ---------------------------------------------------------------------------

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

export interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
}

export interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GmailFilter {
  id: string;
  criteria?: GmailFilterCriteria;
  action?: GmailFilterAction;
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
  internalDate?: string;
}

export interface GmailMessageList {
  messages?: GmailMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export async function listLabels(env: GmailEnv): Promise<GmailLabel[]> {
  const data = await gmailJson<{ labels: GmailLabel[] }>(
    env,
    "/users/me/labels",
  );
  return data.labels ?? [];
}

export async function createLabel(env: GmailEnv, name: string): Promise<GmailLabel> {
  return gmailJson<GmailLabel>(env, "/users/me/labels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteLabel(env: GmailEnv, labelId: string): Promise<void> {
  const res = await gmailFetch(env, `/users/me/labels/${labelId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`deleteLabel ${res.status}: ${body.slice(0, 200)}`);
  }
}

export async function updateLabel(
  env: GmailEnv,
  labelId: string,
  name: string,
): Promise<GmailLabel> {
  return gmailJson<GmailLabel>(env, `/users/me/labels/${labelId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export async function listFilters(env: GmailEnv): Promise<GmailFilter[]> {
  const data = await gmailJson<{ filter: GmailFilter[] }>(
    env,
    "/users/me/settings/filters",
  );
  return data.filter ?? [];
}

export async function createFilter(
  env: GmailEnv,
  criteria: GmailFilterCriteria,
  action: GmailFilterAction,
): Promise<GmailFilter> {
  return gmailJson<GmailFilter>(env, "/users/me/settings/filters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ criteria, action }),
  });
}

export async function deleteFilter(env: GmailEnv, filterId: string): Promise<void> {
  const res = await gmailFetch(env, `/users/me/settings/filters/${filterId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`deleteFilter ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(
  env: GmailEnv,
  query: string,
  maxResults = 500,
  pageToken?: string,
  labelIds?: string[],
): Promise<GmailMessageList> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });
  if (pageToken) params.set("pageToken", pageToken);
  // Filter by label ID rather than "label:<name>" in q, which is ambiguous
  // for nested label names.
  for (const id of labelIds ?? []) params.append("labelIds", id);
  return gmailJson<GmailMessageList>(env, `/users/me/messages?${params}`);
}

/** Paginate listMessages until exhausted or limit reached. Returns all message IDs. */
export async function listAllMessageIds(
  env: GmailEnv,
  query: string,
  limit = 5000,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listMessages(env, query, 500, pageToken);
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < limit);
  return ids;
}

export async function getMessage(
  env: GmailEnv,
  id: string,
  metadataHeaders: string[] = ["From", "Date"],
): Promise<GmailMessage> {
  const params = new URLSearchParams();
  params.set("format", "metadata");
  for (const h of metadataHeaders) {
    params.append("metadataHeaders", h);
  }
  return gmailJson<GmailMessage>(env, `/users/me/messages/${id}?${params}`);
}

// Google caps a batch at 100 calls and recommends <= 50 to stay clear of the
// per-user rate limit (messages.get costs 5 quota units, 250 units/s allowed).
export const BATCH_GET_MAX = 50;

/**
 * Fetch metadata for many messages with ONE HTTP request via the Gmail batch
 * endpoint. Counts as a single Worker subrequest no matter how many IDs are
 * packed in, which is what lets a scan cover hundreds of messages on the
 * Free plan (50 subrequests per invocation).
 *
 * Messages whose inner response is not 200 are omitted from `messages`; the
 * failure is reported in `errors` and the caller may retry them later.
 */
export async function batchGetMessages(
  env: GmailEnv,
  ids: string[],
  metadataHeaders: string[] = ["From", "Date"],
): Promise<{ messages: GmailMessage[]; errors: string[] }> {
  if (ids.length === 0) return { messages: [], errors: [] };
  if (ids.length > BATCH_GET_MAX) {
    throw new Error(`batchGetMessages: ${ids.length} ids exceeds BATCH_GET_MAX=${BATCH_GET_MAX}`);
  }

  const params = new URLSearchParams();
  params.set("format", "metadata");
  for (const h of metadataHeaders) params.append("metadataHeaders", h);

  const boundary = `batch_${crypto.randomUUID()}`;
  const body =
    ids
      .map(
        (id, i) =>
          `--${boundary}\r\n` +
          `Content-Type: application/http\r\n` +
          `Content-ID: <${i}>\r\n\r\n` +
          `GET /gmail/v1/users/me/messages/${id}?${params}\r\n\r\n`,
      )
      .join("") + `--${boundary}--\r\n`;

  const res = await gmailFetch(env, GMAIL_BATCH_URL, {
    method: "POST",
    headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail batch ${res.status}: ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const boundaryMatch = contentType.match(/boundary=("?)([^";]+)\1/);
  if (!boundaryMatch?.[2]) {
    throw new Error(`Gmail batch: no boundary in response content-type "${contentType}"`);
  }
  const text = await res.text();

  const messages: GmailMessage[] = [];
  const errors: string[] = [];
  for (const rawPart of text.split(`--${boundaryMatch[2]}`)) {
    const part = rawPart.trim();
    if (!part || part === "--") continue;

    // Part layout: outer MIME headers, blank line, inner HTTP status line +
    // headers, blank line, JSON body.
    const blank = /\r?\n\r?\n/g;
    const first = blank.exec(part);
    const second = first ? blank.exec(part) : null;
    if (!first || !second) {
      errors.push(`batch part unparseable: ${part.slice(0, 120)}`);
      continue;
    }
    const inner = part.slice(first.index + first[0].length, second.index);
    const json = part.slice(second.index + second[0].length).trim();
    const status = parseInt(inner.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] ?? "0", 10);
    const idx = part.match(/Content-ID:\s*<response-(\d+)>/i)?.[1];
    const id = idx !== undefined ? ids[parseInt(idx, 10)] : "?";

    if (status !== 200) {
      errors.push(`batch get ${id}: ${status} ${json.slice(0, 200)}`);
      continue;
    }
    try {
      messages.push(JSON.parse(json) as GmailMessage);
    } catch (e) {
      errors.push(`batch get ${id}: bad JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { messages, errors };
}

export async function batchModify(
  env: GmailEnv,
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  const res = await gmailFetch(env, "/users/me/messages/batchModify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids,
      addLabelIds: addLabelIds.length ? addLabelIds : undefined,
      removeLabelIds: removeLabelIds.length ? removeLabelIds : undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`batchModify ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

export function getHeader(message: GmailMessage, name: string): string | null {
  const headers = message.payload?.headers ?? [];
  for (const h of headers) {
    if (h.name.toLowerCase() === name.toLowerCase()) return h.value;
  }
  return null;
}

/** Extract the domain from a From header value. Returns the registered domain or null. */
export function extractDomain(fromHeader: string): string | null {
  // From: "Name" <user@example.com>  or  user@example.com
  const match = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([\w.+-]+@[\w.-]+)/);
  const email = match?.[1];
  if (!email) return null;
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 0) return null;
  return email.slice(atIdx + 1).toLowerCase();
}
