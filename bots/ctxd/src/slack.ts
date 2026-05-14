// Ported from ctxd CLI src/ctxd/dumpers/slack.py + router.py.

const ARCHIVES_RE = /\/archives\/(?<channel>[A-Z0-9]+)\/p(?<ts>\d{16,})/;
const CLIENT_RE = /\/client\/[^/]+\/(?<channel>[A-Z0-9]+)\/thread\/[^/-]+-(?<ts>\d+\.\d+)/;
const THREAD_TS_QUERY_RE = /[?&]thread_ts=(\d+\.\d+)/;
const SLACK_HOST_RE = /^https?:\/\/[^/]*slack\.com\//;

const USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g;
const CHANNEL_MENTION_RE = /<#([CG][A-Z0-9]+)(?:\|([^>]+))?>/g;
const LINK_LABELED_RE = /<(https?:\/\/[^|>]+)\|([^>]+)>/g;
const LINK_PLAIN_RE = /<(https?:\/\/[^>]+)>/g;

export function isSlackUrl(url: string): boolean {
  return SLACK_HOST_RE.test(url);
}

interface ParsedUrl {
  channel: string;
  threadTs: string; // ts to pass to conversations.replies (thread root, or message ts if not a reply)
  targetTs: string; // ts of the specific message the URL points to
}

export function parseSlackUrl(url: string): ParsedUrl {
  const client = url.match(CLIENT_RE);
  if (client?.groups) {
    const ts = client.groups.ts!;
    return { channel: client.groups.channel!, threadTs: ts, targetTs: ts };
  }
  const archives = url.match(ARCHIVES_RE);
  if (!archives?.groups) {
    throw new Error(`unsupported slack url: ${url}`);
  }
  const channel = archives.groups.channel!;
  const rawTs = archives.groups.ts!;
  const targetTs = `${rawTs.slice(0, 10)}.${rawTs.slice(10, 16)}`;
  const threadQuery = url.match(THREAD_TS_QUERY_RE);
  const threadTs = threadQuery ? threadQuery[1]! : targetTs;
  return { channel, threadTs, targetTs };
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
}

interface SlackUser {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  profile?: {
    display_name_normalized?: string;
    real_name_normalized?: string;
  };
}

interface SlackFile {
  name?: string;
  mimetype?: string;
  permalink?: string;
  url_private?: string;
}

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
  files?: SlackFile[];
}

interface RepliesPayload extends SlackApiResponse {
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

interface UserInfoPayload extends SlackApiResponse {
  user?: SlackUser;
}

interface ChannelInfoPayload extends SlackApiResponse {
  channel?: { name?: string };
}

async function slackApi<T extends SlackApiResponse>(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`slack ${method} http ${res.status}`);
  const json = (await res.json()) as T;
  if (!json.ok) {
    const detail = json.needed ? ` (needed: ${json.needed})` : "";
    throw new Error(`slack ${method}: ${json.error ?? "unknown"}${detail}`);
  }
  return json;
}

async function fetchThread(token: string, channel: string, threadTs: string): Promise<SlackMessage[]> {
  const all: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const params: Record<string, string> = {
      channel,
      ts: threadTs,
      limit: "200",
      inclusive: "true",
    };
    if (cursor) params.cursor = cursor;
    const payload = await slackApi<RepliesPayload>(token, "conversations.replies", params);
    all.push(...(payload.messages ?? []));
    cursor = payload.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return all;
}

interface ResolvedUser {
  display: string;
  realName: string;
  isBot: boolean;
}

class Resolver {
  private users = new Map<string, ResolvedUser>();
  private channels = new Map<string, string>();

  constructor(private token: string) {}

  async user(id: string): Promise<ResolvedUser> {
    const hit = this.users.get(id);
    if (hit) return hit;
    try {
      const payload = await slackApi<UserInfoPayload>(this.token, "users.info", { user: id });
      const u = payload.user ?? {};
      const display =
        u.profile?.display_name_normalized ||
        u.profile?.real_name_normalized ||
        u.real_name ||
        u.name ||
        id;
      const resolved: ResolvedUser = {
        display,
        realName: u.profile?.real_name_normalized || u.real_name || "",
        isBot: !!u.is_bot,
      };
      this.users.set(id, resolved);
      return resolved;
    } catch {
      const fallback: ResolvedUser = { display: id, realName: "", isBot: false };
      this.users.set(id, fallback);
      return fallback;
    }
  }

  async channel(id: string): Promise<string> {
    const hit = this.channels.get(id);
    if (hit) return hit;
    try {
      const payload = await slackApi<ChannelInfoPayload>(this.token, "conversations.info", {
        channel: id,
      });
      const name = payload.channel?.name ?? id;
      this.channels.set(id, name);
      return name;
    } catch {
      this.channels.set(id, id);
      return id;
    }
  }

  async renderText(text: string): Promise<string> {
    let out = text
      .replaceAll("<!here>", "@here")
      .replaceAll("<!channel>", "@channel")
      .replaceAll("<!everyone>", "@everyone");

    const userIds = new Set<string>();
    for (const m of out.matchAll(USER_MENTION_RE)) userIds.add(m[1]!);
    for (const id of userIds) await this.user(id);
    out = out.replace(USER_MENTION_RE, (_m, id: string) => `@${this.users.get(id)?.display ?? id}`);

    const channelIds = new Set<string>();
    for (const m of out.matchAll(CHANNEL_MENTION_RE)) channelIds.add(m[1]!);
    for (const id of channelIds) await this.channel(id);
    out = out.replace(CHANNEL_MENTION_RE, (_m, id: string, label: string | undefined) => {
      return `#${label ?? this.channels.get(id) ?? id}`;
    });

    out = out.replace(LINK_LABELED_RE, "[$2]($1)");
    out = out.replace(LINK_PLAIN_RE, "$1");

    // Guard markdown-link URLs, emoji codes, and bare URLs from the *_~ regexes
    // below — Slack emoji codes (:raising_hand:) and URLs with `_` get mangled
    // otherwise (e.g. ?thread_ts= → ?thread*ts=).
    const guards: string[] = [];
    const guard = (s: string): string => {
      guards.push(s);
      return `\x00${guards.length - 1}\x00`;
    };
    out = out.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, guard);
    out = out.replace(/:[A-Za-z0-9_+-]+:/g, guard);
    out = out.replace(/https?:\/\/\S+/g, guard);

    out = out.replace(/\*([^*]+)\*/g, "**$1**");
    out = out.replace(/_([^_]+)_/g, "*$1*");
    out = out.replace(/~([^~]+)~/g, "~~$1~~");

    out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => guards[Number(i)] ?? "");
    return out;
  }
}

function formatTs(ts: string): string {
  const epoch = Number.parseFloat(ts);
  if (!Number.isFinite(epoch)) return ts;
  return new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export interface NestedSlackLink {
  url: string;
  channel: string;
  threadTs: string;
  quotedBy: string;
  quotedAt: string;
}

export interface RenderedMessage {
  ts: string;          // formatted "YYYY-MM-DD HH:MM:SS"
  speaker: string;     // "@display"
  body: string;        // rendered markdown body
  attachments: string[]; // formatted attachment lines (without leading "Attachments:" header)
}

export interface SlackFetchResult {
  channelId: string;
  channelName: string;
  channelHeader: string; // "#name (ID) @ root-ts"
  threadTs: string;
  participants: string[]; // pre-formatted "- @display (Real)"
  rootMessage: RenderedMessage;
  replies: RenderedMessage[];
  nestedSlackLinks: NestedSlackLink[];
  markdown: string; // composite — root + replies, used for summary
}

export function renderMessageBlock(m: RenderedMessage): string {
  let s = `### [${m.speaker}] ${m.ts}\n${m.body}`;
  if (m.attachments.length > 0) {
    s += `\n\nAttachments:\n${m.attachments.join("\n")}`;
  }
  return s;
}

const SLACK_URL_IN_TEXT_RE = /https?:\/\/[a-z0-9.-]*slack\.com\/[^\s)\]>]+/gi;

function extractSlackUrls(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(SLACK_URL_IN_TEXT_RE)) {
    const u = m[0].replace(/[.,;]+$/, "");
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

export async function fetchSlackThread(token: string, url: string): Promise<SlackFetchResult> {
  const { channel, threadTs } = parseSlackUrl(url);
  const resolver = new Resolver(token);
  const messages = await fetchThread(token, channel, threadTs);
  if (messages.length === 0) throw new Error("slack: empty thread");

  const channelName = await resolver.channel(channel);
  const channelHeader = `#${channelName} (${channel}) @ ${formatTs(messages[0]!.ts)}`;

  const participantIds = Array.from(
    new Set(messages.map((m) => m.user).filter((u): u is string => !!u)),
  );
  const participants: string[] = [];
  for (const uid of participantIds) {
    const u = await resolver.user(uid);
    let label = `- @${u.display}`;
    if (u.realName && u.realName !== u.display) label += ` (${u.realName})`;
    if (u.isBot) label += " [BOT]";
    participants.push(label);
  }

  const rendered: RenderedMessage[] = [];
  const nestedSeen = new Set<string>();
  const nestedSlackLinks: NestedSlackLink[] = [];
  const messageTsSet = new Set(messages.map((m) => m.ts));

  for (const msg of messages) {
    let speaker: string;
    if (msg.user) {
      const u = await resolver.user(msg.user);
      speaker = `@${u.display}`;
    } else if (msg.bot_profile?.name || msg.username) {
      speaker = `@${msg.bot_profile?.name ?? msg.username} [BOT]`;
    } else {
      speaker = "@unknown";
    }
    const body = await resolver.renderText(msg.text ?? "");
    const ts = formatTs(msg.ts);
    const attachments: string[] = [];
    if (msg.files && msg.files.length > 0) {
      for (const f of msg.files) {
        attachments.push(
          `- [${f.name ?? "attachment"}] (${f.mimetype ?? "unknown"}) — ${f.permalink ?? f.url_private ?? "n/a"}`,
        );
      }
    }
    rendered.push({ ts, speaker, body, attachments });

    for (const candidateUrl of extractSlackUrls(body)) {
      let parsed: ParsedUrl;
      try {
        parsed = parseSlackUrl(candidateUrl);
      } catch {
        continue;
      }
      // Dedup by the SPECIFIC message the URL points to (channel + targetTs).
      // Two URLs to different replies in the same thread are distinct quotes.
      const key = `${parsed.channel}:${parsed.targetTs}`;
      if (parsed.channel === channel && messageTsSet.has(parsed.targetTs)) continue;
      if (nestedSeen.has(key)) continue;
      nestedSeen.add(key);
      nestedSlackLinks.push({
        url: candidateUrl,
        channel: parsed.channel,
        threadTs: parsed.threadTs,
        quotedBy: speaker,
        quotedAt: ts,
      });
    }
  }

  const rootMessage = rendered[0]!;
  const replies = rendered.slice(1);

  const lines: string[] = [];
  lines.push(`# Slack Thread: ${channelHeader}`);
  lines.push("");
  lines.push(`Participants (${participants.length}):`);
  lines.push(...participants);
  lines.push("");
  lines.push("## Conversation");
  lines.push("");
  for (const m of rendered) {
    lines.push(renderMessageBlock(m));
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return {
    channelId: channel,
    channelName,
    channelHeader,
    threadTs,
    participants,
    rootMessage,
    replies,
    nestedSlackLinks,
    markdown: lines.join("\n").trim() + "\n",
  };
}

export interface SingleMessageResult {
  url: string;
  channelId: string;
  channelHeader: string;
  message: RenderedMessage;
  /** True when the URL points to a reply inside a thread (i.e. there's a larger thread root above). */
  isThreadReply: boolean;
}

/**
 * Fetch and render a single Slack message — the exact message the URL points to.
 * Used for "翻译 引用 N" where we only want the one quoted message, not the whole thread.
 */
export async function fetchSingleMessage(token: string, url: string): Promise<SingleMessageResult> {
  const { channel, threadTs, targetTs } = parseSlackUrl(url);
  const resolver = new Resolver(token);
  const messages = await fetchThread(token, channel, threadTs);
  if (messages.length === 0) throw new Error("slack: message not found");

  const channelName = await resolver.channel(channel);
  const channelHeader = `#${channelName} (${channel}) @ ${formatTs(messages[0]!.ts)}`;

  const msg = messages.find((m) => m.ts === targetTs) ?? messages[0]!;

  let speaker: string;
  if (msg.user) {
    const u = await resolver.user(msg.user);
    speaker = `@${u.display}`;
  } else if (msg.bot_profile?.name || msg.username) {
    speaker = `@${msg.bot_profile?.name ?? msg.username} [BOT]`;
  } else {
    speaker = "@unknown";
  }
  const body = await resolver.renderText(msg.text ?? "");
  const ts = formatTs(msg.ts);
  const attachments: string[] = [];
  if (msg.files && msg.files.length > 0) {
    for (const f of msg.files) {
      attachments.push(
        `- [${f.name ?? "attachment"}] (${f.mimetype ?? "unknown"}) — ${f.permalink ?? f.url_private ?? "n/a"}`,
      );
    }
  }

  return {
    url,
    channelId: channel,
    channelHeader,
    message: { ts, speaker, body, attachments },
    isThreadReply: threadTs !== targetTs,
  };
}

const FENCE_RE = /```([\s\S]*?)```/g;

/**
 * Shrink long triple-backtick code blocks (SQL, logs, etc.) — keep only the first
 * meaningful line + a Chinese elision placeholder. Saves big tokens in translation
 * prompts; the LLM is instructed (in the system prompt) not to translate code anyway.
 */
export function compressCodeBlocks(text: string): string {
  return text.replace(FENCE_RE, (whole, inner: string) => {
    const lines = inner.split("\n");
    const meaningful = lines.filter((l) => l.trim().length > 0);
    if (meaningful.length <= 2 && inner.length < 200) return whole;
    const first = meaningful[0] ?? "";
    return "```\n" + first + `\n[... 省略 ${lines.length - 1} 行 / ${inner.length} 字符 ...]\n` + "```";
  });
}

/**
 * Lean block for translation prompts: speaker/ts header + body (code blocks
 * compressed). Drops attachment lines — file names / URLs are noise for translation.
 */
export function renderLeanBlock(m: RenderedMessage): string {
  return `### [${m.speaker}] ${m.ts}\n${compressCodeBlocks(m.body)}`;
}
