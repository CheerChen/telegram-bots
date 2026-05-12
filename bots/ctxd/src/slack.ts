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
  threadTs: string;
}

export function parseSlackUrl(url: string): ParsedUrl {
  const client = url.match(CLIENT_RE);
  if (client?.groups) {
    return { channel: client.groups.channel!, threadTs: client.groups.ts! };
  }
  const archives = url.match(ARCHIVES_RE);
  if (!archives?.groups) {
    throw new Error(`unsupported slack url: ${url}`);
  }
  const channel = archives.groups.channel!;
  const rawTs = archives.groups.ts!;
  const threadQuery = url.match(THREAD_TS_QUERY_RE);
  if (threadQuery) {
    return { channel, threadTs: threadQuery[1]! };
  }
  return { channel, threadTs: `${rawTs.slice(0, 10)}.${rawTs.slice(10, 16)}` };
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
    out = out.replace(/\*([^*]+)\*/g, "**$1**");
    out = out.replace(/_([^_]+)_/g, "*$1*");
    out = out.replace(/~([^~]+)~/g, "~~$1~~");
    return out;
  }
}

function formatTs(ts: string): string {
  const epoch = Number.parseFloat(ts);
  if (!Number.isFinite(epoch)) return ts;
  return new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export interface SlackFetchResult {
  channelId: string;
  channelName: string;
  threadTs: string;
  markdown: string;
}

export async function fetchSlackThread(token: string, url: string): Promise<SlackFetchResult> {
  const { channel, threadTs } = parseSlackUrl(url);
  const resolver = new Resolver(token);
  const messages = await fetchThread(token, channel, threadTs);
  if (messages.length === 0) throw new Error("slack: empty thread");

  const channelName = await resolver.channel(channel);
  const participants = Array.from(
    new Set(messages.map((m) => m.user).filter((u): u is string => !!u)),
  );

  const lines: string[] = [];
  lines.push(`# Slack Thread: #${channelName} (${channel}) @ ${formatTs(messages[0]!.ts)}`);
  lines.push("");
  lines.push(`Participants (${participants.length}):`);
  for (const uid of participants) {
    const u = await resolver.user(uid);
    let label = `- @${u.display}`;
    if (u.realName && u.realName !== u.display) label += ` (${u.realName})`;
    if (u.isBot) label += " [BOT]";
    lines.push(label);
  }
  lines.push("");
  lines.push("## Conversation");
  lines.push("");

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
    lines.push(`### [${speaker}] ${formatTs(msg.ts)}`);
    lines.push(body);
    if (msg.files && msg.files.length > 0) {
      lines.push("");
      lines.push("Attachments:");
      for (const f of msg.files) {
        lines.push(
          `- [${f.name ?? "attachment"}] (${f.mimetype ?? "unknown"}) — ${f.permalink ?? f.url_private ?? "n/a"}`,
        );
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return {
    channelId: channel,
    channelName,
    threadTs,
    markdown: lines.join("\n").trim() + "\n",
  };
}
