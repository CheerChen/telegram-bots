// Daily check-in worker: Outlook calendar (Graph API, ICS fallback) + Jira
// sprint tickets -> Slack DM. Cron fires 10:00 JST on weekdays.
//
// Ported from services/daily-checkin (Pi/Docker). MSAL is replaced with a raw
// OAuth refresh_token grant; the rotating refresh token lives in KV. When the
// tenant force-expires it (~monthly sign-in frequency policy), the alert DM
// carries a permanent /auth/start link that re-seeds KV via Auth Code + PKCE.

import ICAL from "ical.js";

interface Env {
  OUTLOOK_ICS_URL: string;
  AZURE_CLIENT_ID: string;
  AZURE_TENANT_ID: string;
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  SLACK_BOT_TOKEN: string;
  SLACK_DM_CHANNEL_ID: string;
  ADMIN_SECRET?: string;
  PUBLIC_URL: string;
  MEETING_TITLE_BLACKLIST?: string;
  MIN_MEETING_TITLE_LENGTH?: string;
  CHECKIN_STATE: KVNamespace;
}

const GRAPH_SCOPE = "https://graph.microsoft.com/Calendars.Read offline_access openid profile";
const KV_REFRESH_TOKEN = "graph:refresh_token";

interface CalEvent {
  subject: string;
  startJst: Date;
  isAllDay: boolean;
  status: string;
  transp: string;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
function jstWindow(now: Date): { todayStr: string; dayStart: Date; dayEnd: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const todayStr = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    todayStr,
    dayStart: new Date(`${todayStr}T00:00:00+09:00`),
    dayEnd: new Date(`${todayStr}T23:59:59+09:00`),
  };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
async function slackApi(env: Env, method: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`slack ${method} HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) throw new Error(`slack ${method} failed: ${data.error}`);
  return data;
}

/** Resolve SLACK_DM_CHANNEL_ID (U... user id opens an IM) to a channel id. */
async function resolveChannel(env: Env): Promise<string> {
  if (!env.SLACK_DM_CHANNEL_ID.startsWith("U")) return env.SLACK_DM_CHANNEL_ID;
  const data = await slackApi(env, "conversations.open", { users: env.SLACK_DM_CHANNEL_ID });
  return (data.channel as { id: string }).id;
}

async function postSlack(env: Env, text: string, blocks?: unknown[]): Promise<void> {
  const channel = await resolveChannel(env);
  const payload: Record<string, unknown> = { channel, text };
  if (blocks) payload.blocks = blocks;
  const data = await slackApi(env, "chat.postMessage", payload);
  console.log(`[slack] sent: channel=${data.channel} ts=${data.ts}`);
}

// ---------------------------------------------------------------------------
// Graph auth: refresh_token grant against the KV-stored rotating token
// ---------------------------------------------------------------------------
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_codes?: number[];
  error_description?: string;
}

function tokenEndpoint(env: Env): string {
  return `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
}

async function getGraphAccessToken(env: Env): Promise<string> {
  const refreshToken = await env.CHECKIN_STATE.get(KV_REFRESH_TOKEN);
  if (!refreshToken) throw new Error("no refresh token in KV; visit /auth/start");

  const res = await fetch(tokenEndpoint(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.AZURE_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: GRAPH_SCOPE,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      `token refresh failed (${res.status}): ${data.error} [${data.error_codes?.join(",")}] ` +
        `${(data.error_description ?? "").slice(0, 200)}`,
    );
  }
  // Entra rotates refresh tokens on every use — persist the new one.
  if (data.refresh_token) {
    await env.CHECKIN_STATE.put(KV_REFRESH_TOKEN, data.refresh_token);
  }
  console.log(`[graph] token refresh OK (rotated=${Boolean(data.refresh_token)})`);
  return data.access_token;
}

interface GraphEvent {
  subject: string;
  isAllDay: boolean;
  showAs: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

async function fetchGraphEvents(env: Env, dayStart: Date, dayEnd: Date): Promise<CalEvent[]> {
  const accessToken = await getGraphAccessToken(env);
  const params = new URLSearchParams({
    startDateTime: dayStart.toISOString(),
    endDateTime: dayEnd.toISOString(),
    $select: "subject,isAllDay,start,end,showAs",
    $orderby: "start/dateTime",
    $top: "50",
  });
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="Asia/Tokyo"',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { value?: GraphEvent[] };
  const graphEvents = data.value ?? [];
  console.log(`[graph] event count=${graphEvents.length}`);
  const events = graphEvents.map((e) => ({
    subject: e.subject,
    // dateTime is JST (Prefer header) with 7-digit fraction; trim for Date.parse
    startJst: new Date(`${e.start.dateTime.replace(/\.\d+$/, "")}+09:00`),
    isAllDay: e.isAllDay,
    status: "",
    transp: e.showAs === "free" ? "TRANSPARENT" : "OPAQUE",
  }));
  events.sort((a, b) => a.startJst.getTime() - b.startJst.getTime());
  return events;
}

// ---------------------------------------------------------------------------
// ICS fallback: publish URL -> today's events (RRULE expansion included)
// ---------------------------------------------------------------------------
async function fetchIcsEvents(env: Env, dayStart: Date, dayEnd: Date): Promise<CalEvent[]> {
  console.log(`[ics] GET ${env.OUTLOOK_ICS_URL.slice(0, 60)}...`);
  const res = await fetch(env.OUTLOOK_ICS_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
  const icsText = await res.text();

  const comp = new ICAL.Component(ICAL.parse(icsText));
  const vevents = comp.getAllSubcomponents("vevent");
  console.log(`[ics] total vevents: ${vevents.length}`);

  // Collect time ranges of cancelled exceptions (SUMMARY starts with キャンセル済み).
  // ical.js iterator does not replace RRULE occurrences with RECURRENCE-ID
  // exceptions, so both the normal occurrence and the cancelled one appear.
  // We use these ranges to suppress the un-cancelled duplicate.
  const cancelledRanges: { start: number; end: number }[] = [];
  for (const v of vevents) {
    const summary = String(v.getFirstPropertyValue("summary") ?? "");
    if (!summary.startsWith("キャンセル済み")) continue;
    const ev = new ICAL.Event(v);
    if (ev.startDate && ev.endDate) {
      cancelledRanges.push({
        start: ev.startDate.toJSDate().getTime(),
        end: ev.endDate.toJSDate().getTime(),
      });
    }
  }

  const events: CalEvent[] = [];
  // Compare via JS Date epoch milliseconds — ical.js Time.compare has timezone
  // pitfalls (floating vs TZID) that let yesterday's events leak into today.
  const rangeStartMs = dayStart.getTime();
  const rangeEndMs = dayEnd.getTime();
  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
    let occurrences: { startDate: ICAL.Time; endDate: ICAL.Time }[] = [];
    if (event.isRecurring()) {
      const it = event.iterator();
      let next: ICAL.Time | null;
      while ((next = it.next())) {
        const occ = event.getOccurrenceDetails(next);
        const occStartMs = occ.startDate.toJSDate().getTime();
        if (occStartMs > rangeEndMs) break;
        const occEndMs = (occ.endDate ?? occ.startDate).toJSDate().getTime();
        if (occEndMs < rangeStartMs) continue;
        occurrences.push({ startDate: occ.startDate, endDate: occ.endDate });
      }
    } else {
      const s = event.startDate;
      const e = event.endDate;
      const sMs = s.toJSDate().getTime();
      const eMs = (e ?? s).toJSDate().getTime();
      if (sMs <= rangeEndMs && eMs >= rangeStartMs) {
        occurrences.push({ startDate: s, endDate: e });
      }
    }
    for (const occ of occurrences) {
      const subject = String(vevent.getFirstPropertyValue("summary") ?? "(no title)");
      const status = String(vevent.getFirstPropertyValue("status") ?? "");
      const transp = String(vevent.getFirstPropertyValue("transp") ?? "");
      const isAllDay = occ.startDate.icaltype === "date";
      const startJst = occ.startDate.toJSDate();
      // Skip non-cancelled events that overlap a cancelled exception range.
      if (!subject.startsWith("キャンセル済み")) {
        const sMs = occ.startDate.toJSDate().getTime();
        const eMs = (occ.endDate ?? occ.startDate).toJSDate().getTime();
        if (cancelledRanges.some((r) => sMs < r.end && eMs > r.start)) {
          console.log(`[ics] skip (cancelled exception): ${JSON.stringify(subject)}`);
          continue;
        }
      }
      events.push({ subject, startJst, isAllDay, status, transp });
    }
  }

  events.sort((a, b) => a.startJst.getTime() - b.startJst.getTime());
  console.log(`[ics] events within today's JST window: ${events.length}`);
  return events;
}

// ---------------------------------------------------------------------------
// Jira: POST /rest/api/3/search/jql
// ---------------------------------------------------------------------------
interface JiraIssue {
  key: string;
  fields: { summary: string; status: { name: string } };
}

async function fetchSprintIssues(env: Env): Promise<JiraIssue[]> {
  const url = `${env.JIRA_BASE_URL.replace(/\/$/, "")}/rest/api/3/search/jql`;
  // NOTE: this tenant has multiple custom fields named "sprint", so JQL must
  // reference the field by its custom-field id (cf[10020]) instead of the name.
  const jql =
    "cf[10020] in openSprints()" +
    " AND assignee = currentUser()" +
    " AND statusCategory != Done";
  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ jql, fields: ["summary", "status"], maxResults: 50 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { issues?: JiraIssue[] };
  const issues = data.issues ?? [];
  console.log(`[jira] issue count=${issues.length}`);
  return issues;
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------
function composeCheckin(env: Env, events: CalEvent[], issues: JiraIssue[]): { text: string; blocks: unknown[] } {
  const blacklist = (env.MEETING_TITLE_BLACKLIST ?? "キャンセル済み")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const minTitleLength = parseInt(env.MIN_MEETING_TITLE_LENGTH ?? "5", 10);

  const mtgItems: string[] = [];
  for (const e of events) {
    const subj = e.subject.trim();
    if (blacklist.some((p) => subj.startsWith(p))) {
      console.log(`[compose] skip (blacklist): ${JSON.stringify(subj)}`);
      continue;
    }
    if (subj.length < minTitleLength) {
      console.log(`[compose] skip (title too short, len=${subj.length}): ${JSON.stringify(subj)}`);
      continue;
    }
    mtgItems.push(`【MTG】${subj}`);
  }

  const ticketItems = issues.map((i) => `${i.key}: ${i.fields.summary}`);
  const yaruItems = [...mtgItems, ...ticketItems];

  const yaruBody = yaruItems.map((x) => `    • ${x}`).join("\n");
  const text =
    "神保町勤務開始します。\n" +
    "本日残業について:`10時間を超えない見込み` です。\n" +
    "\n" +
    "• やること\n" +
    `${yaruBody}\n`;

  const blocks = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "神保町勤務開始します。\n本日残業について: " },
            { type: "text", text: "10時間を超えない見込み", style: { code: true } },
            { type: "text", text: " です。\n" },
          ],
        },
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 0,
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "やること" }],
            },
          ],
        },
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 1,
          elements: yaruItems.map((item) => ({
            type: "rich_text_section",
            elements: [{ type: "text", text: item }],
          })),
        },
      ],
    },
  ];

  return { text, blocks };
}

// ---------------------------------------------------------------------------
// Check-in run
// ---------------------------------------------------------------------------
async function runCheckin(env: Env, send: boolean): Promise<string> {
  const { todayStr, dayStart, dayEnd } = jstWindow(new Date());
  console.log(`[time] JST today = ${todayStr}`);

  let events: CalEvent[];
  try {
    events = await fetchGraphEvents(env, dayStart, dayEnd);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    console.log(`[graph] unavailable, fallback to ICS: ${msg}`);
    try {
      await postSlack(
        env,
        `:warning: daily-checkin: Graph auth failed, fell back to ICS.\n` +
          `Re-auth (any device, link never expires): ${authStartUrl(env)}\n` +
          `detail: ${msg}`,
      );
    } catch (notifyExc) {
      console.log(`[graph] auth alert failed: ${notifyExc}`);
    }
    events = await fetchIcsEvents(env, dayStart, dayEnd);
  }

  const issues = await fetchSprintIssues(env);
  const { text, blocks } = composeCheckin(env, events, issues);
  console.log(`[compose] message:\n${text}`);

  if (send) await postSlack(env, text, blocks);
  return text;
}

// ---------------------------------------------------------------------------
// Auth Code + PKCE re-seeding flow
// ---------------------------------------------------------------------------
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authStartUrl(env: Env): string {
  return `${env.PUBLIC_URL}/auth/start?key=${env.ADMIN_SECRET ?? ""}`;
}

async function handleAuthStart(env: Env): Promise<Response> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  await env.CHECKIN_STATE.put(`pkce:${state}`, verifier, { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${env.PUBLIC_URL}/auth/callback`,
    response_mode: "query",
    scope: GRAPH_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return Response.redirect(
    `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/authorize?${params}`,
    302,
  );
}

async function handleAuthCallback(env: Env, url: URL): Promise<Response> {
  const err = url.searchParams.get("error");
  if (err) {
    return html(`Auth error: ${err} — ${url.searchParams.get("error_description") ?? ""}`, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html("missing code/state", 400);

  const verifier = await env.CHECKIN_STATE.get(`pkce:${state}`);
  if (!verifier) return html("unknown or expired state — restart from /auth/start", 400);
  await env.CHECKIN_STATE.delete(`pkce:${state}`);

  const res = await fetch(tokenEndpoint(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.AZURE_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.PUBLIC_URL}/auth/callback`,
      code_verifier: verifier,
      scope: GRAPH_SCOPE,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.refresh_token) {
    return html(
      `Token exchange failed (${res.status}): ${data.error} ${(data.error_description ?? "").slice(0, 300)}`,
      500,
    );
  }
  await env.CHECKIN_STATE.put(KV_REFRESH_TOKEN, data.refresh_token);
  console.log("[auth] refresh token re-seeded via /auth/callback");
  return html("<h1>Auth OK</h1><p>daily-checkin re-authorized. You can close this tab.</p>");
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// Entrypoints
// ---------------------------------------------------------------------------
function isAuthorized(req: Request, url: URL, env: Env): boolean {
  if (!env.ADMIN_SECRET) return false;
  return (
    req.headers.get("x-checkin-secret") === env.ADMIN_SECRET ||
    url.searchParams.get("key") === env.ADMIN_SECRET
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/auth/callback") return handleAuthCallback(env, url);

    if (url.pathname === "/auth/start") {
      if (!isAuthorized(req, url, env)) return new Response("forbidden", { status: 403 });
      return handleAuthStart(env);
    }

    if (url.pathname === "/preview") {
      if (!isAuthorized(req, url, env)) return new Response("forbidden", { status: 403 });
      const text = await runCheckin(env, false);
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/run") {
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      if (!isAuthorized(req, url, env)) return new Response("forbidden", { status: 403 });
      const text = await runCheckin(env, true);
      return new Response(`sent\n\n${text}`, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCheckin(env, true).catch(async (exc) => {
        // Fail loud: any crash (Jira down, ICS broken, Slack error) lands in the DM.
        const msg = exc instanceof Error ? exc.message : String(exc);
        console.log(`[cron] run failed: ${msg}`);
        await postSlack(env, `:rotating_light: daily-checkin run failed: ${msg}`).catch((e) =>
          console.log(`[cron] failure alert also failed: ${e}`),
        );
      }),
    );
  },
};
