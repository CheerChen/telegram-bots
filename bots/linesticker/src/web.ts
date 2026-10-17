// WeChat path: ilink has no sticker message, and WeChat shows GIF image
// messages as stills. A forwarded GIF from the in-app browser does animate,
// so WeChat users get a public page listing the pack as GIFs (static packs as
// PNG). The import workflow converts and PUTs each image here; KV holds them.
//
//   POST /wx/request        clawbot (x-claw-secret): {text} -> {reply}
//   GET  /wx/<id>           page: grid when ready, auto-refreshing otherwise
//   GET  /wx/<id>/<i>       one image
//   PUT  /wx/<id>/<i>       import job (x-import-secret): image bytes
//   PUT  /wx/<id>           import job: {status, count} progress / result
import { escapeHtml } from "shared/telegram";
import { fetchMeta, isAnimated, parseProductId, pickTitle } from "./line.ts";
import { SET_MAX } from "./stickers.ts";

export interface WebEnv {
  WEB: KVNamespace;
  CLAW_SECRET: string;
  IMPORT_SECRET: string;
}

export interface WebPack {
  title: string;
  total: number;
  animated: boolean;
  status: "pending" | "ready" | "failed";
  count: number;
  requestedAt: number;
}

// A pending job older than this is assumed dead and may be re-dispatched.
const PENDING_STALE_MS = 15 * 60_000;

const packKey = (id: string) => `pack:${id}`;
const imageKey = (id: string, i: number) => `img:${id}:${i}`;

export async function getPack(env: WebEnv, id: string): Promise<WebPack | null> {
  return env.WEB.get<WebPack>(packKey(id), "json");
}

async function putPack(env: WebEnv, id: string, pack: WebPack): Promise<void> {
  await env.WEB.put(packKey(id), JSON.stringify(pack));
}

function pageUrl(origin: string, id: string): string {
  return `${origin}/wx/${id}`;
}

// Returns the reply text for clawbot. `dispatch` starts the wechat import.
async function handleRequest(
  env: WebEnv,
  origin: string,
  text: string,
  dispatch: (productId: string) => Promise<void>,
): Promise<string> {
  const id = parseProductId(text);
  if (!id) return "请发一个 LINE 贴纸商店链接。";
  const meta = await fetchMeta(id);
  if (!meta) return `找不到 LINE 贴纸包 ${id}。`;

  const title = pickTitle(meta);
  const url = pageUrl(origin, id);
  const pack = await getPack(env, id);
  if (pack?.status === "ready") {
    return `${title}（${pack.total} 张）\n${url}\n\n打开后长按图片转发即可。`;
  }
  const running = pack?.status === "pending" && Date.now() - pack.requestedAt < PENDING_STALE_MS;
  if (!running) {
    await dispatch(id);
    await putPack(env, id, {
      title,
      total: Math.min(meta.stickers.length, SET_MAX),
      animated: isAnimated(meta),
      status: "pending",
      count: pack?.count ?? 0,
      requestedAt: Date.now(),
    });
  }
  return `⏳ 正在转换 ${title}，通常需要 1–3 分钟。\n${url}\n\n页面会自动刷新，完成后长按图片转发即可。`;
}

const PAGE_STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f6; --fg: #222; --muted: #888; --tile: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #999; --tile: #1c1c1c; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
h1 { font-size: 17px; margin: 0 0 4px; }
p { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.grid img { width: 100%; aspect-ratio: 1; object-fit: contain; background: var(--tile); border-radius: 8px; }
`;

function page(title: string, body: string, refresh = false): Response {
  const html =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    (refresh ? `<meta http-equiv="refresh" content="10">` : "") +
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function renderPack(id: string, pack: WebPack | null): Response {
  if (!pack) return page("未找到", `<h1>还没有转换过这个包</h1><p>在微信里把 LINE 链接发给 bot 即可开始转换。</p>`);
  const title = escapeHtml(pack.title);
  if (pack.status === "failed") {
    return page(pack.title, `<h1>${title}</h1><p>转换失败。在微信里重新发一次链接即可重试。</p>`);
  }
  if (pack.status !== "ready") {
    return page(pack.title, `<h1>${title}</h1><p>⏳ 正在转换（${pack.count}/${pack.total}），页面每 10 秒自动刷新。</p>`, true);
  }
  const kind = pack.animated ? "动态" : "静态";
  const imgs = Array.from(
    { length: pack.count },
    (_, i) => `<img src="/wx/${id}/${i}" loading="lazy" alt="">`,
  ).join("");
  return page(
    pack.title,
    `<h1>${title}</h1><p>${pack.count} 张${kind}贴纸 · 长按图片转发给朋友（页面里不会动，发出去会动）</p><div class="grid">${imgs}</div>`,
  );
}

async function serveImage(env: WebEnv, id: string, i: number): Promise<Response> {
  const { value, metadata } = await env.WEB.getWithMetadata<{ type: string }>(imageKey(id, i), "arrayBuffer");
  if (!value) return new Response("not found", { status: 404 });
  return new Response(value, {
    headers: {
      "content-type": metadata?.type ?? "image/gif",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function handlePut(env: WebEnv, req: Request, id: string, index: string | undefined): Promise<Response> {
  if (req.headers.get("x-import-secret") !== env.IMPORT_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  if (index !== undefined) {
    const type = req.headers.get("content-type") ?? "image/gif";
    await env.WEB.put(imageKey(id, Number(index)), await req.arrayBuffer(), { metadata: { type } });
    return new Response("ok");
  }
  const pack = await getPack(env, id);
  if (!pack) return new Response("no pack", { status: 404 });
  const update = (await req.json()) as Partial<Pick<WebPack, "status" | "count">>;
  await putPack(env, id, { ...pack, ...update });
  return new Response("ok");
}

// Returns null when the path is not under /wx.
export async function handleWeb(
  env: WebEnv,
  req: Request,
  dispatch: (productId: string) => Promise<void>,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/wx/request" && req.method === "POST") {
    if (req.headers.get("x-claw-secret") !== env.CLAW_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const { text } = (await req.json()) as { text?: string };
    const reply = await handleRequest(env, url.origin, text ?? "", dispatch);
    return Response.json({ reply });
  }

  const m = url.pathname.match(/^\/wx\/(\d{1,12})(?:\/(\d{1,3}))?$/);
  if (!m) return null;
  const [, id, index] = m as unknown as [string, string, string | undefined];
  if (req.method === "PUT") return handlePut(env, req, id, index);
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (index !== undefined) return serveImage(env, id, Number(index));
  if (url.searchParams.has("json")) return Response.json(await getPack(env, id));
  return renderPack(id, await getPack(env, id));
}
