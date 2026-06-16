import { load } from "cheerio";
import { sendMessage } from "shared/telegram";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  STAGEWATCH_ADMIN_SECRET?: string;
  STAGEWATCH_STATE: KVNamespace;
}

type ParserName =
  | "jvc"
  | "rythem"
  | "yuiyui"
  | "perfume"
  | "mizuki"
  | "kotoko"
  | "twice"
  | "wordpress";

interface SourceBase {
  name: string;
  parser: ParserName;
  titleIncludes?: string;
}

interface JvcSource extends SourceBase {
  parser: "jvc";
  kind: "artist" | "series";
  id: string;
  label?: string;
}

interface UrlSource<T extends Exclude<ParserName, "jvc" | "mizuki">> extends SourceBase {
  parser: T;
  url: string;
}

interface MizukiSource extends SourceBase {
  parser: "mizuki";
  url: string;
  apiUrl: string;
}

type Source =
  | JvcSource
  | UrlSource<"rythem">
  | UrlSource<"yuiyui">
  | UrlSource<"perfume">
  | MizukiSource
  | UrlSource<"kotoko">
  | UrlSource<"twice">
  | UrlSource<"wordpress">;

interface Item {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
}

interface SourceState {
  initialized: boolean;
  seenIds: string[];
  lastRun?: string;
}

interface RunOptions {
  simulateInit?: boolean;
  sourceNames?: string[];
}

interface RunStats {
  processed: number;
  notified: number;
  failures: number;
  skipped: number;
  logs: string[];
}

const CRON = "7 22 * * *";
const STATE_PREFIX = "source:";
const MAX_SEEN_IDS = 500;

const SOURCES: Source[] = [
  { name: "坂本真綾", parser: "jvc", kind: "artist", id: "A008957" },
  { name: "YENA", parser: "jvc", kind: "artist", id: "A029411" },
  { name: "マクロスF", parser: "jvc", kind: "series", id: "Z0221", label: "flyingdog" },
  { name: "RYTHEM", parser: "rythem", url: "https://www.rythem.jp/info" },
  { name: "牧野由依", parser: "yuiyui", url: "https://www.yuiyuimakino.com/news/index.php" },
  { name: "Perfume Live", parser: "perfume", url: "https://www.perfume-web.jp/news/live.php" },
  {
    name: "水樹奈々",
    parser: "mizuki",
    url: "https://www.mizukinana.jp/news/",
    apiUrl: "https://www.mizukinana.jp/news/100.json",
  },
  { name: "KOTOKO", parser: "kotoko", url: "https://nbcuni-music.com/kotoko/news/list00010000.html" },
  { name: "TWICE Live", parser: "twice", url: "https://www.twicejapan.com/schedule/list/4" },
  {
    name: "AQUAPLUS Event (WHITE ALBUM)",
    parser: "wordpress",
    url: "https://blog.aquaplus.jp/category/info/event",
    titleIncludes: "WHITE ALBUM",
  },
];

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stateKey(sourceName: string): string {
  return `${STATE_PREFIX}${sourceName}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function shortHash(...parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-1", data);
  return toHex(new Uint8Array(digest)).slice(0, 12);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "application/json, text/plain, */*",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`fetch ${res.status}: ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`fetch ${res.status}: ${url}`);
  return res.text();
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function trimSeenIds(ids: string[]): string[] {
  return ids.slice(-MAX_SEEN_IDS);
}

async function loadState(kv: KVNamespace, sourceName: string): Promise<SourceState> {
  const raw = await kv.get(stateKey(sourceName));
  if (!raw) return { initialized: false, seenIds: [] };
  const parsed = JSON.parse(raw) as Partial<SourceState>;
  return {
    initialized: parsed.initialized === true,
    seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter((v): v is string => typeof v === "string") : [],
    lastRun: typeof parsed.lastRun === "string" ? parsed.lastRun : undefined,
  };
}

async function saveState(kv: KVNamespace, sourceName: string, state: SourceState): Promise<void> {
  await kv.put(
    stateKey(sourceName),
    JSON.stringify({
      initialized: state.initialized,
      seenIds: trimSeenIds(state.seenIds),
      lastRun: state.lastRun,
    }),
  );
}

async function parseJvc(source: JvcSource): Promise<Item[]> {
  const url =
    source.kind === "artist"
      ? `https://www.jvcmusic.co.jp/-/Information/${source.id}.json`
      : `https://www.jvcmusic.co.jp/${source.label}/-/News2/${source.id}.json?page=1`;
  const rowsKey = source.kind === "artist" ? "news" : "articles";
  const raw = (await fetchJson(url)) as {
    contents?: { news?: Array<Record<string, string>>; articles?: Array<Record<string, string>> };
  };
  const rows = raw.contents?.[rowsKey] ?? [];
  return rows
    .map((row) => ({
      id: (row.url ?? "").trim(),
      title: (row.title ?? "").trim(),
      url: (row.url ?? "").trim(),
      publishedAt: (row.open_dt ?? "").trim(),
    }))
    .filter((item) => item.id && item.title && item.url);
}

async function parseRythem(source: UrlSource<"rythem">): Promise<Item[]> {
  const $ = load(await fetchText(source.url));
  const items: Item[] = [];
  $("section.Oqnisf").each((_, el) => {
    const classes = ($(el).attr("class") ?? "").split(/\s+/);
    const compId = classes.find((c) => c.startsWith("comp-"));
    if (!compId) return;

    let title = "";
    $(el)
      .find(".wixui-rich-text")
      .each((__, rt) => {
        if (title) return;
        const heading = $(rt).find("h1,h2,h3,h4,h5,h6").first();
        if (heading.length) title = normalizeTitle(heading.text());
      });
    if (!title) title = normalizeTitle($(el).find(".wixui-rich-text").first().text());
    if (!title || title === "INFORMATION" || title === "More") return;
    if (title.length > 120) title = `${title.slice(0, 117)}...`;
    items.push({ id: `rythem:${compId}`, title, url: source.url, publishedAt: "" });
  });
  return items;
}

async function parseYuiyui(source: UrlSource<"yuiyui">): Promise<Item[]> {
  const $ = load(await fetchText(source.url));
  const items: Item[] = [];
  const sections = $("section.entry_area").toArray();
  for (const el of sections) {
    const title = normalizeTitle($(el).find(".entry_title").first().text());
    if (!title) continue;
    const date = normalizeTitle($(el).find(".entry_date").first().text());
    items.push({
      id: `yuiyui:${await shortHash(date, title)}`,
      title,
      url: source.url,
      publishedAt: date,
    });
  }
  return items;
}

async function parsePerfume(source: UrlSource<"perfume">): Promise<Item[]> {
  const $ = load(await fetchText(source.url));
  return $("div.c-news__item")
    .toArray()
    .map((el) => {
      const href = $(el).find("a[href]").first().attr("href");
      const title = normalizeTitle($(el).find(".c-news__name").first().text());
      const date = normalizeTitle($(el).find(".c-news__date").first().text());
      if (!href || !title) return null;
      return {
        id: new URL(href, source.url).toString(),
        title,
        url: new URL(href, source.url).toString(),
        publishedAt: date,
      } satisfies Item;
    })
    .filter((item): item is Item => item !== null);
}

async function parseMizuki(source: MizukiSource): Promise<Item[]> {
  const raw = (await fetchJson(source.apiUrl)) as {
    articles?: Array<{ id?: number | string; title?: string; date?: string }>;
  };
  return (raw.articles ?? [])
    .map((row) => {
      const id = row.id;
      const title = normalizeTitle(row.title ?? "");
      if (id === undefined || !title) return null;
      return {
        id: `mizuki:${id}`,
        title,
        url: source.url,
        publishedAt: normalizeTitle(row.date ?? ""),
      } satisfies Item;
    })
    .filter((item): item is Item => item !== null);
}

async function parseKotoko(source: UrlSource<"kotoko">): Promise<Item[]> {
  const $ = load(await fetchText(source.url));
  return $("tr")
    .toArray()
    .map((el) => {
      const anchor = $(el).find("td.read .title a[href]").first();
      const href = anchor.attr("href");
      const title = normalizeTitle(anchor.text());
      const date = normalizeTitle($(el).find("td.day").first().text());
      if (!href || !title) return null;
      return {
        id: new URL(href, source.url).toString(),
        title,
        url: new URL(href, source.url).toString(),
        publishedAt: date,
      } satisfies Item;
    })
    .filter((item): item is Item => item !== null);
}

async function parseWordpress(source: UrlSource<"wordpress">): Promise<Item[]> {
  const $ = load(await fetchText(source.url));
  return $("[id^='post-']")
    .toArray()
    .map((el) => {
      const anchor = $(el).find(".entry-title a, h1 a, h2 a, h3 a").first();
      const href = anchor.attr("href");
      const title = normalizeTitle(anchor.text());
      if (!href || !title) return null;
      return {
        id: new URL(href, source.url).toString(),
        title,
        url: new URL(href, source.url).toString(),
        publishedAt: "",
      } satisfies Item;
    })
    .filter((item): item is Item => item !== null);
}

async function parseTwice(source: UrlSource<"twice">): Promise<Item[]> {
  const $ = load(await fetchText(source.url));
  return $("ul.newsList > li")
    .toArray()
    .map((el) => {
      const anchor = $(el).find("a[href]").first();
      const href = anchor.attr("href");
      const title = normalizeTitle(anchor.find(".tit").first().text());
      if (!href || !title) return null;
      return {
        id: new URL(href, source.url).toString(),
        title,
        url: new URL(href, source.url).toString(),
        publishedAt: "",
      } satisfies Item;
    })
    .filter((item): item is Item => item !== null);
}

async function parseSource(source: Source): Promise<Item[]> {
  switch (source.parser) {
    case "jvc":
      return parseJvc(source);
    case "rythem":
      return parseRythem(source);
    case "yuiyui":
      return parseYuiyui(source);
    case "perfume":
      return parsePerfume(source);
    case "mizuki":
      return parseMizuki(source);
    case "kotoko":
      return parseKotoko(source);
    case "twice":
      return parseTwice(source);
    case "wordpress":
      return parseWordpress(source);
  }
}

function applyTitleFilter(source: Source, items: Item[]): Item[] {
  const keyword = source.titleIncludes?.toLowerCase();
  if (!keyword) return items;
  return items.filter((item) => item.title.toLowerCase().includes(keyword));
}

async function notify(env: Env, sourceName: string, item: Item): Promise<void> {
  const text = `【${sourceName}】${item.title}\n${item.url}`;
  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId: env.TELEGRAM_CHAT_ID,
    text,
    disableWebPagePreview: true,
  });
}

async function processSource(env: Env, source: Source, options: RunOptions, stats: RunStats): Promise<void> {
  const state = await loadState(env.STAGEWATCH_STATE, source.name);
  stats.logs.push(`[${source.name}] start`);

  let items: Item[];
  try {
    items = applyTitleFilter(source, await parseSource(source));
  } catch (error) {
    stats.failures += 1;
    stats.logs.push(`[${source.name}] fetch/parse error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!items.length) {
    stats.skipped += 1;
    stats.logs.push(`[${source.name}] no items returned`);
    return;
  }

  if (!state.initialized) {
    const seed = options.simulateInit ? items.slice(1) : items;
    state.initialized = true;
    state.seenIds = trimSeenIds(seed.map((item) => item.id));
    state.lastRun = nowIso();
    await saveState(env.STAGEWATCH_STATE, source.name, state);
    stats.processed += 1;
    stats.logs.push(
      options.simulateInit
        ? `[${source.name}] simulate-init seeded ${seed.length}, skipped newest`
        : `[${source.name}] initialized with ${seed.length} items`,
    );
    return;
  }

  const seen = new Set(state.seenIds);
  const newItems = items.filter((item) => !seen.has(item.id));
  if (!newItems.length) {
    state.lastRun = nowIso();
    await saveState(env.STAGEWATCH_STATE, source.name, state);
    stats.processed += 1;
    stats.logs.push(`[${source.name}] no new items`);
    return;
  }

  for (const item of [...newItems].reverse()) {
    try {
      await notify(env, source.name, item);
      state.seenIds.push(item.id);
      stats.notified += 1;
      stats.logs.push(`[${source.name}] notified: ${item.title}`);
    } catch (error) {
      stats.failures += 1;
      stats.logs.push(`[${source.name}] notify failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  state.lastRun = nowIso();
  state.seenIds = trimSeenIds(state.seenIds);
  await saveState(env.STAGEWATCH_STATE, source.name, state);
  stats.processed += 1;
}

function selectSources(sourceNames?: string[]): Source[] {
  if (!sourceNames?.length) return SOURCES;
  const wanted = new Set(sourceNames);
  return SOURCES.filter((source) => wanted.has(source.name));
}

async function runMonitor(env: Env, options: RunOptions = {}): Promise<RunStats> {
  const stats: RunStats = { processed: 0, notified: 0, failures: 0, skipped: 0, logs: [] };
  const sources = selectSources(options.sourceNames);
  for (const source of sources) {
    await processSource(env, source, options, stats);
  }
  const missing = (options.sourceNames ?? []).filter((name) => !sources.some((source) => source.name === name));
  if (missing.length) stats.logs.push(`unknown sources: ${missing.join(", ")}`);
  return stats;
}

function parseRunOptions(req: Request): RunOptions {
  const url = new URL(req.url);
  return {
    simulateInit: url.searchParams.get("simulate_init") === "1",
    sourceNames: url.searchParams.getAll("source"),
  };
}

function isAuthorized(req: Request, env: Env): boolean {
  if (!env.STAGEWATCH_ADMIN_SECRET) return false;
  return req.headers.get("x-stagewatch-secret") === env.STAGEWATCH_ADMIN_SECRET;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json({
        name: "stagewatch-bot",
        cron: CRON,
        sources: SOURCES.map((source) => source.name),
      });
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (!isAuthorized(req, env)) return new Response("forbidden", { status: 403 });
      const stats = await runMonitor(env, parseRunOptions(req));
      return Response.json(stats);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMonitor(env));
  },
};
