// WeChat path: ilink has no sticker message, and WeChat shows GIF image
// messages as stills. A forwarded GIF from the in-app browser does animate,
// so WeChat users get a public page listing the pack as GIFs (static stickers
// too, so forwards keep transparency). The import workflow converts and PUTs
// each image here; KV holds them.
//
//   GET  /wx/               home: every ready pack, newest first
//   POST /wx/request        clawbot (x-claw-secret): {text} -> {reply}
//   GET  /wx/<id>           page: grid when ready, auto-refreshing otherwise
//   GET  /wx/<id>/<i>       one image
//   GET  /wx/omggif.js      GIF decoder for the page (MIT, vendored)
//   PUT  /wx/<id>/<i>       import job (x-import-secret): image bytes
//   PUT  /wx/<id>           import job: {status, count} progress / result
//
// Public but unlisted for search engines: every /wx response carries
// X-Robots-Tag: noindex, and /robots.txt disallows /wx/.
import { escapeHtml } from "shared/telegram";
import { type CatalogEntry, upsertEntry } from "./catalog.ts";
import { fetchMeta, isAnimated, parseProductId, pickTitle } from "./line.ts";
import { SET_MAX } from "./stickers.ts";
import OMGGIF from "./vendor/omggif-1.0.10.js.txt";

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
const CATALOG_KEY = "catalog";
const NOINDEX = { "x-robots-tag": "noindex" };

export async function getPack(env: WebEnv, id: string): Promise<WebPack | null> {
  return env.WEB.get<WebPack>(packKey(id), "json");
}

async function putPack(env: WebEnv, id: string, pack: WebPack): Promise<void> {
  await env.WEB.put(packKey(id), JSON.stringify(pack));
}

const toEntry = (id: string, pack: WebPack, readyAt: number): CatalogEntry =>
  ({ id, title: pack.title, animated: pack.animated, count: pack.count, readyAt });

// Built once from the packs when the key is missing (first deploy, or the key
// was deleted); afterwards kept current by addToCatalog.
async function getCatalog(env: WebEnv): Promise<CatalogEntry[]> {
  const stored = await env.WEB.get<CatalogEntry[]>(CATALOG_KEY, "json");
  if (stored) return stored;
  let catalog: CatalogEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.WEB.list({ prefix: "pack:", cursor });
    for (const { name } of page.keys) {
      const id = name.slice("pack:".length);
      const pack = await getPack(env, id);
      if (pack?.status === "ready") catalog = upsertEntry(catalog, toEntry(id, pack, pack.requestedAt));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await env.WEB.put(CATALOG_KEY, JSON.stringify(catalog));
  return catalog;
}

// Read-modify-write: two imports finishing in the same instant could drop one
// entry; deleting the catalog key rebuilds it from the packs.
async function addToCatalog(env: WebEnv, id: string, pack: WebPack): Promise<void> {
  const catalog = await getCatalog(env);
  await env.WEB.put(CATALOG_KEY, JSON.stringify(upsertEntry(catalog, toEntry(id, pack, Date.now()))));
}

function pageUrl(origin: string, id: string): string {
  return `${origin}/wx/${id}`;
}

// Returns the reply text for clawbot. `dispatch` starts the wechat import.
// ilink messages can't be edited, so the reply never states progress: it reads
// as done, and the page itself shows conversion state until it is.
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
  const total = Math.min(meta.stickers.length, SET_MAX);
  const reply = `${title}（${total} 张）\n${url}\n\n长按图片即可转发。`;
  const pack = await getPack(env, id);
  if (pack?.status === "ready") return reply;
  const running = pack?.status === "pending" && Date.now() - pack.requestedAt < PENDING_STALE_MS;
  if (!running) {
    await dispatch(id);
    await putPack(env, id, {
      title,
      total,
      animated: isAnimated(meta),
      status: "pending",
      count: pack?.count ?? 0,
      requestedAt: Date.now(),
    });
  }
  return reply;
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
.t { position: relative; aspect-ratio: 1; background: var(--tile); border-radius: 8px; overflow: hidden; }
.t img, .t canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.t.playing img { opacity: 0; }
a { color: inherit; text-decoration: none; }
.back { display: inline-block; margin-bottom: 8px; font-size: 13px; color: var(--muted); }
.home { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.cap { margin-top: 4px; font-size: 12px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap small { display: block; color: var(--muted); }
`;

function page(title: string, body: string, refresh = false): Response {
  const html =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    (refresh ? `<meta http-equiv="refresh" content="10">` : "") +
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...NOINDEX } });
}

// WeChat's iOS web view shows GIF <img> as a still, but JS and canvas run.
// Each tile decodes its GIF onto a canvas and keeps the real GIF <img> on top
// at opacity 0, so a long press still forwards the animated GIF itself.
const PLAYER = `
(function () {
  function play(tile) {
    var img = tile.querySelector("img");
    fetch(img.src).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var g; try { g = new exports.GifReader(new Uint8Array(buf)); } catch (e) { return; }
      var n = g.numFrames(); if (n < 2) return;
      var cv = document.createElement("canvas"); cv.width = g.width; cv.height = g.height;
      var ctx = cv.getContext("2d"), px = ctx.createImageData(g.width, g.height), k = 0;
      tile.insertBefore(cv, img); tile.classList.add("playing");
      (function step() {
        var f = g.frameInfo(k);
        if (k === 0) px.data.fill(0);
        g.decodeAndBlitFrameRGBA(k, px.data); ctx.putImageData(px, 0, 0);
        if (f.disposal === 2) {
          for (var y = f.y; y < f.y + f.height; y++)
            for (var x = f.x; x < f.x + f.width; x++) px.data[(y * g.width + x) * 4 + 3] = 0;
        }
        k = (k + 1) % n;
        setTimeout(step, Math.max(20, (f.delay || 5) * 10));
      })();
    }).catch(function () {});
  }
  var tiles = document.querySelectorAll(".t");
  if (!("IntersectionObserver" in window)) { tiles.forEach(play); return; }
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); play(e.target); } });
  }, { rootMargin: "200px" });
  tiles.forEach(function (t) { io.observe(t); });
})();`;

const BACK = `<a class="back" href="/wx/">← 全部贴纸</a>`;

function renderHome(catalog: CatalogEntry[]): Response {
  if (!catalog.length) return page("LINE 贴纸", `<h1>LINE 贴纸</h1><p>还没有转换好的贴纸包。</p>`);
  const cards = catalog.map((e) =>
    `<a href="/wx/${e.id}"><div class="t"><img src="/wx/${e.id}/0" loading="lazy" alt=""></div>` +
    `<div class="cap">${escapeHtml(e.title)}<small>${e.count} 张${e.animated ? "动态" : "静态"}</small></div></a>`,
  ).join("");
  return page("LINE 贴纸", `<h1>LINE 贴纸</h1><p>${catalog.length} 个包 · 点开后长按图片转发</p><div class="grid home">${cards}</div>`);
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
    (_, i) => `<div class="t"><img src="/wx/${id}/${i}" loading="lazy" alt=""></div>`,
  ).join("");
  const player = pack.animated
    ? `<script>var exports={};</script><script src="/wx/omggif.js"></script><script>${PLAYER}</script>`
    : "";
  return page(
    pack.title,
    `${BACK}<h1>${title}</h1><p>${pack.count} 张${kind}贴纸 · 长按图片转发给朋友</p><div class="grid">${imgs}</div>${player}`,
  );
}

async function serveImage(env: WebEnv, id: string, i: number): Promise<Response> {
  const { value, metadata } = await env.WEB.getWithMetadata<{ type: string }>(imageKey(id, i), "arrayBuffer");
  if (!value) return new Response("not found", { status: 404 });
  return new Response(value, {
    headers: {
      "content-type": metadata?.type ?? "image/gif",
      "cache-control": "public, max-age=31536000, immutable",
      ...NOINDEX,
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
  const next = { ...pack, ...update };
  await putPack(env, id, next);
  if (update.status === "ready") await addToCatalog(env, id, next);
  return new Response("ok");
}

// Returns null when the path is neither under /wx nor /robots.txt.
export async function handleWeb(
  env: WebEnv,
  req: Request,
  dispatch: (productId: string) => Promise<void>,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /wx/\n", { headers: { "content-type": "text/plain" } });
  }
  if ((url.pathname === "/wx" || url.pathname === "/wx/") && req.method === "GET") {
    return renderHome(await getCatalog(env));
  }
  if (url.pathname === "/wx/omggif.js") {
    return new Response(OMGGIF, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
    });
  }
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
