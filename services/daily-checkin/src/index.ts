// One-shot check-in script: calendar + Jira sprint tickets -> Slack DM.
// Ported from the original Python checkin.py.
//
// Graph path uses @azure/msal-node (Authorization Code Flow + PKCE).
// Falls back to ICS if Graph auth/token/API access is unavailable.
// On token failure, sends a Slack DM alert so the owner can refresh.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import ICAL from "ical.js";
import {
  PublicClientApplication,
  type Configuration,
  type AuthenticationResult,
} from "@azure/msal-node";

// ---------------------------------------------------------------------------
// 1. Load and validate env
// ---------------------------------------------------------------------------
const REQUIRED = [
  "OUTLOOK_ICS_URL",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_DM_CHANNEL_ID",
] as const;
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[env] missing required vars: ${missing.join(", ")}`);
  process.exit(1);
}

const OUTLOOK_ICS_URL = process.env.OUTLOOK_ICS_URL!;
const JIRA_BASE_URL = process.env.JIRA_BASE_URL!.replace(/\/$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL!;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_DM_CHANNEL_ID = process.env.SLACK_DM_CHANNEL_ID!;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;
const AUTO_SEND = ["1", "true", "yes", "y"].includes(
  (process.env.AUTO_SEND ?? "").toLowerCase(),
);
const MSAL_CACHE_PATH = process.env.MSAL_CACHE_PATH ?? ".msal_cache.json";
const MEETING_TITLE_BLACKLIST = (process.env.MEETING_TITLE_BLACKLIST ?? "キャンセル済み")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MIN_MEETING_TITLE_LENGTH = parseInt(
  process.env.MIN_MEETING_TITLE_LENGTH ?? "5",
  10,
);

console.log(`[env] all ${REQUIRED.length} vars present`);

// JST today
const JST = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo" });
function jstDate(d: Date): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { y: +get("year"), m: +get("month"), day: +get("day") };
}
const { y, m, day } = jstDate(new Date());
const todayStr = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
// JST = UTC+9, so day_start in UTC = y-m-day 00:00 JST = y-m-(day-1) 15:00 UTC
const dayStart = new Date(`${todayStr}T00:00:00+09:00`);
const dayEnd = new Date(`${todayStr}T23:59:59+09:00`);
console.log(
  `[time] JST today = ${todayStr} (${dayStart.toISOString()} ~ ${dayEnd.toISOString()})`,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface CalEvent {
  subject: string;
  startJst: Date;
  isAllDay: boolean;
  status: string;
  transp: string;
}

interface GraphEvent {
  subject: string;
  isAllDay: boolean;
  showAs: string;
  start: string;
  end: string;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), ...init });
  if (!res.ok) throw new Error(`fetch ${res.status}: ${url}`);
  return res.json();
}

/** Send a Slack DM alerting that the MSAL token expired. */
async function notifyTokenExpired(detail: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    "Content-Type": "application/json; charset=utf-8",
  };
  let channel = SLACK_DM_CHANNEL_ID;
  if (channel.startsWith("U")) {
    const data = (await fetchJson("https://slack.com/api/conversations.open", {
      method: "POST",
      headers,
      body: JSON.stringify({ users: channel }),
    })) as { ok: boolean; channel?: { id: string }; error?: string };
    if (!data.ok) throw new Error(`conversations.open failed: ${data.error}`);
    channel = data.channel!.id;
  }
  const text =
    `:warning: daily-checkin: Microsoft Graph token expired, ` +
    `fell back to ICS. Run \`make -C services/daily-checkin auth\` then \`pi-deploy\`.\n` +
    `detail: ${detail}`;
  const data = (await fetchJson("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, text }),
  })) as { ok: boolean; channel?: string; ts?: string; error?: string };
  if (!data.ok) throw new Error(`chat.postMessage failed: ${data.error}`);
  console.log(`[msal] token-expired alert sent: channel=${data.channel} ts=${data.ts}`);
}

// ---------------------------------------------------------------------------
// 2. Outlook ICS publish URL -> today's events
// ---------------------------------------------------------------------------
console.log(`[ics] GET ${OUTLOOK_ICS_URL.slice(0, 60)}...`);
const icsRes = await fetch(OUTLOOK_ICS_URL, { signal: AbortSignal.timeout(30000) });
console.log(`[ics] status=${icsRes.status} bytes=${(await icsRes.clone().arrayBuffer()).byteLength}`);
if (!icsRes.ok) throw new Error(`ICS fetch failed: ${icsRes.status}`);
const icsText = await icsRes.text();

const jcal = ICAL.parse(icsText);
const comp = new ICAL.Component(jcal);
const prodId = comp.getFirstPropertyValue("prodid");
const calName = comp.getFirstPropertyValue("x-wr-calname");
console.log(`[ics] PRODID=${prodId} X-WR-CALNAME=${calName}`);

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
  const s = new ICAL.Event(v).startDate;
  const e = new ICAL.Event(v).endDate;
  if (s && e) {
    cancelledRanges.push({ start: s.toJSDate().getTime(), end: e.toJSDate().getTime() });
  }
}

const icsEvents: CalEvent[] = [];
// Compare via JS Date epoch milliseconds — ical.js Time.compare has timezone
// pitfalls (floating vs TZID) that let yesterday's events leak into today.
const rangeStartMs = dayStart.getTime();
const rangeEndMs = dayEnd.getTime();
for (const vevent of vevents) {
  const event = new ICAL.Event(vevent);
  // Expand recurring events into today's window
  const expand = event.isRecurring();
  let occurrences: { startDate: ICAL.Time; endDate: ICAL.Time }[] = [];
  if (expand) {
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
    // Skip non-cancelled events that overlap a cancelled exception range
    // (ical.js doesn't replace RRULE occurrences with RECURRENCE-ID exceptions).
    if (!subject.startsWith("キャンセル済み")) {
      const sMs = occ.startDate.toJSDate().getTime();
      const eMs = (occ.endDate ?? occ.startDate).toJSDate().getTime();
      if (cancelledRanges.some((r) => sMs < r.end && eMs > r.start)) {
        console.log(`[ics] skip (cancelled exception): ${JSON.stringify(subject)}`);
        continue;
      }
    }
    icsEvents.push({ subject, startJst, isAllDay, status, transp });
  }
}

icsEvents.sort((a, b) => a.startJst.getTime() - b.startJst.getTime());
console.log(`[ics] events within today's JST window: ${icsEvents.length}`);
for (const e of icsEvents) {
  console.log(
    `  - ${JSON.stringify(e.subject)} | start=${e.startJst.toISOString()}` +
    ` | allDay=${e.isAllDay} | status=${e.status} | transp=${e.transp}`,
  );
}

let events: CalEvent[] = icsEvents;

// ---------------------------------------------------------------------------
// 2b. Graph path via Entra public client (Authorization Code Flow + PKCE)
// Falls back to ICS if Graph auth/token/API access is unavailable.
// ---------------------------------------------------------------------------
if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
  console.log("[msal] AZURE_CLIENT_ID / AZURE_TENANT_ID not set; using ICS events");
} else {
  try {
    const msalConfig: Configuration = {
      auth: {
        clientId: AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (cacheContext) => {
            if (existsSync(MSAL_CACHE_PATH)) {
              cacheContext.cache.deserialize(
                readFileSync(MSAL_CACHE_PATH, "utf-8"),
              );
              console.log(`[msal] loaded cache (${MSAL_CACHE_PATH})`);
            }
          },
          afterCacheAccess: async (cacheContext) => {
            if (cacheContext.cacheHasChanged) {
              const dir = dirname(MSAL_CACHE_PATH);
              if (dir && !existsSync(dir)) {
                // ensure dir exists (best-effort)
              }
              writeFileSync(MSAL_CACHE_PATH, cacheContext.cache.serialize());
              console.log(`[msal] saved cache (${MSAL_CACHE_PATH})`);
            }
          },
        },
      },
    };

    const msalApp = new PublicClientApplication(msalConfig);
    const scopes = ["Calendars.Read"];
    const tokenCache = msalApp.getTokenCache();
    const accounts = await tokenCache.getAllAccounts();

    let tokenResult: AuthenticationResult | null = null;
    if (accounts.length > 0) {
      console.log(
        `[msal] cached accounts: ${accounts.map((a) => a.username).join(", ")}`,
      );
      try {
        tokenResult = await msalApp.acquireTokenSilent({
          account: accounts[0]!,
          scopes,
        });
        if (tokenResult?.accessToken) console.log("[msal] silent token OK");
      } catch {
        // silent failed, fall through to error below
      }
    }

    if (!tokenResult?.accessToken) {
      throw new Error(
        "silent token acquisition failed; interactive auth unavailable",
      );
    }

    const graphToken = tokenResult.accessToken;
    console.log(`[msal] got access_token (len=${graphToken.length})`);

    const graphParams = new URLSearchParams({
      startDateTime: dayStart.toISOString(),
      endDateTime: dayEnd.toISOString(),
      $select: "subject,isAllDay,start,end,showAs",
      $orderby: "start/dateTime",
      $top: "50",
    });
    console.log(`[graph] GET /me/calendarView params=${graphParams.toString()}`);
    const graphRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarView?${graphParams}`,
      {
        headers: {
          Authorization: `Bearer ${graphToken}`,
          Prefer: 'outlook.timezone="Asia/Tokyo"',
        },
        signal: AbortSignal.timeout(30000),
      },
    );
    console.log(`[graph] status=${graphRes.status}`);
    if (!graphRes.ok) throw new Error(`Graph API ${graphRes.status}: ${await graphRes.text()}`);

    const graphData = (await graphRes.json()) as { value?: GraphEvent[] };
    const graphEvents = graphData.value ?? [];
    console.log(`[graph] event count=${graphEvents.length}`);
    for (const e of graphEvents) {
      console.log(
        `  - subject=${JSON.stringify(e.subject)} | ${e.start.dateTime} -> ${e.end.dateTime}` +
        ` | showAs=${e.showAs} | allDay=${e.isAllDay}`,
      );
    }
    // Convert Graph events to CalEvent shape
    events = graphEvents.map((e) => ({
      subject: e.subject,
      startJst: new Date(e.start),
      isAllDay: e.isAllDay,
      status: "",
      transp: e.showAs === "free" ? "TRANSPARENT" : "OPAQUE",
    }));
    events.sort((a, b) => a.startJst.getTime() - b.startJst.getTime());
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    console.log(`[msal] Graph path unavailable, fallback to ICS: ${msg}`);
    try {
      await notifyTokenExpired(msg);
    } catch (notifyExc) {
      console.log(
        `[msal] token-expired notify failed: ${notifyExc instanceof Error ? notifyExc.message : notifyExc}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Jira: POST /rest/api/3/search/jql
// ---------------------------------------------------------------------------
const jiraUrl = `${JIRA_BASE_URL}/rest/api/3/search/jql`;
// NOTE: this tenant has multiple custom fields named "sprint", so JQL must
// reference the field by its custom-field id (cf[10020]) instead of the name.
const jiraJql =
  "cf[10020] in openSprints()" +
  " AND assignee = currentUser()" +
  " AND statusCategory != Done";
const jiraBody = { jql: jiraJql, fields: ["summary", "status"], maxResults: 50 };
console.log(`[jira] POST ${jiraUrl}`);
console.log(`[jira] jql=${JSON.stringify(jiraJql)}`);
const jiraAuth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
const jiraRes2 = await fetch(jiraUrl, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Basic ${jiraAuth}`,
  },
  body: JSON.stringify(jiraBody),
  signal: AbortSignal.timeout(30000),
});
console.log(`[jira] status=${jiraRes2.status}`);
if (!jiraRes2.ok) {
  console.log(`[jira] error body: ${await jiraRes2.text()}`);
  throw new Error(`Jira ${jiraRes2.status}`);
}
interface JiraIssue {
  key: string;
  fields: { summary: string; status: { name: string } };
}
const jiraData = (await jiraRes2.json()) as { issues: JiraIssue[] };
const issues = jiraData.issues ?? [];
console.log(`[jira] issue count=${issues.length}`);
for (const i of issues) {
  console.log(`  - ${i.key}: ${JSON.stringify(i.fields.summary)} [${i.fields.status.name}]`);
}

// ---------------------------------------------------------------------------
// 4. Compose message
// ---------------------------------------------------------------------------
const mtgItems: string[] = [];
for (const e of events) {
  const subj = e.subject.trim();
  if (MEETING_TITLE_BLACKLIST.some((p) => subj.startsWith(p))) {
    console.log(`[compose] skip (blacklist): ${JSON.stringify(subj)}`);
    continue;
  }
  if (subj.length < MIN_MEETING_TITLE_LENGTH) {
    console.log(`[compose] skip (title too short, len=${subj.length}): ${JSON.stringify(subj)}`);
    continue;
  }
  mtgItems.push(`【MTG】${subj}`);
}

const ticketItems = issues.map((i) => `${i.key}: ${i.fields.summary}`);
const yaruItems = [...mtgItems, ...ticketItems];

// Plain-text version
const yaruBody = yaruItems.map((x) => `    • ${x}`).join("\n");
const message =
  "神保町勤務開始します。\n" +
  "本日残業について:`10時間を超えない見込み` です。\n" +
  "\n" +
  "• やること\n" +
  `${yaruBody}\n`;

// Block Kit version: rich_text with two nested rich_text_list levels.
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

console.log("\n=== composed message (plain text fallback) ===");
console.log(message);
console.log("=== end ===\n");
console.log("=== composed blocks (Block Kit) ===");
console.log(JSON.stringify(blocks, null, 2));
console.log("=== end ===\n");

// ---------------------------------------------------------------------------
// 5. Confirm + send to Slack
// ---------------------------------------------------------------------------
if (AUTO_SEND) {
  console.log("[slack] AUTO_SEND enabled, skipping confirmation prompt");
} else {
  console.log("[slack] AUTO_SEND not set, would prompt — skipping in non-interactive mode");
  process.exit(0);
}

const slackHeaders = {
  Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
  "Content-Type": "application/json; charset=utf-8",
};
let channel = SLACK_DM_CHANNEL_ID;
if (channel.startsWith("U")) {
  console.log(`[slack] opening IM with user ${channel}`);
  const openRes = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: slackHeaders,
    body: JSON.stringify({ users: channel }),
    signal: AbortSignal.timeout(30000),
  });
  console.log(`[slack] conversations.open status=${openRes.status}`);
  if (!openRes.ok) throw new Error(`conversations.open HTTP ${openRes.status}`);
  const openData = (await openRes.json()) as { ok: boolean; channel?: { id: string }; error?: string };
  console.log(`[slack] conversations.open body: ${JSON.stringify(openData)}`);
  if (!openData.ok) throw new Error(`conversations.open failed: ${openData.error}`);
  channel = openData.channel!.id;
  console.log(`[slack] resolved IM channel=${channel}`);
}

const payload = { channel, text: message, blocks };
console.log(`[slack] chat.postMessage payload keys: ${Object.keys(payload).join(", ")}`);
console.log(`[slack] text fallback: ${JSON.stringify(message)}`);
console.log(`[slack] blocks: ${JSON.stringify(blocks)}`);
const sendRes = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: slackHeaders,
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(30000),
});
console.log(`[slack] chat.postMessage status=${sendRes.status}`);
if (!sendRes.ok) throw new Error(`chat.postMessage HTTP ${sendRes.status}`);
const sendData = (await sendRes.json()) as { ok: boolean; channel?: string; ts?: string; error?: string };
console.log(`[slack] body: ${JSON.stringify(sendData)}`);
if (!sendData.ok) throw new Error(`chat.postMessage failed: ${sendData.error}`);
console.log(`[slack] sent: channel=${sendData.channel} ts=${sendData.ts}`);
