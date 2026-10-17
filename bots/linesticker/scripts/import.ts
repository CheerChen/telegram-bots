// GitHub Actions entry: import one LINE sticker pack into a Telegram set.
//
// Public repo, public logs: never print the product id, title or chat id.
// The product id comes from the event file (not step env, which the log
// header would echo) and is masked as soon as it is read.
//
// Local dry run (no Telegram): DRY_RUN_DIR=out pnpm run import 8525
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteMessage, escapeHtml, sendMessage } from "shared/telegram";
import {
  addStickersUrl,
  androidStaticUrl,
  animationUrl,
  fetchMeta,
  isAnimated,
  type LineStickerMeta,
  pickTitle,
  staticUrl,
  stickerSetName,
} from "../src/line.ts";
import {
  addSetKeyboard,
  addStickerToSet,
  CREATE_BATCH_MAX,
  createNewStickerSet,
  getBotUsername,
  getStickerSet,
  SET_MAX,
  sendSticker,
  type StickerFile,
  TelegramError,
} from "../src/stickers.ts";
import { toGif, toStatic, toVideo } from "./convert.ts";

const CONVERT_CONCURRENCY = 4;

// telegram: build the sticker set. wechat: GIFs for the /wx page (src/web.ts).
type Target = "telegram" | "wechat";

interface Inputs {
  productId: string;
  target: Target;
  // The Worker's "importing" message; deleted before the result is sent.
  progressMessageId?: number;
}

function readInputs(): Inputs {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const inputs = eventPath
    ? JSON.parse(readFileSync(eventPath, "utf8")).inputs ?? {}
    : { product_id: process.argv[2], target: process.env.TARGET };
  const id = String(inputs.product_id ?? "").trim();
  if (process.env.GITHUB_ACTIONS && id) console.log(`::add-mask::${id}`);
  if (!/^\d{1,12}$/.test(id)) throw new Error("product_id must be digits");
  const progress = Number(inputs.progress_message_id);
  const target: Target = inputs.target === "wechat" ? "wechat" : "telegram";
  return { productId: id, target, progressMessageId: Number.isInteger(progress) && progress > 0 ? progress : undefined };
}

async function dropProgress(token: string, owner: string, inputs: Inputs): Promise<void> {
  if (!inputs.progressMessageId) return;
  await deleteMessage(token, owner, inputs.progressMessageId).catch(() => {});
}

async function download(url: string, path: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404 || res.status === 403) return false;
  if (!res.ok) throw new Error(`download ${res.status}`);
  await writeFile(path, new Uint8Array(await res.arrayBuffer()));
  return true;
}

// Apple's CgBI chunk sits right after the PNG signature; ffmpeg can't decode it.
function isCgbi(png: Uint8Array): boolean {
  return new TextDecoder().decode(png.subarray(12, 16)) === "CgBI";
}

interface Converted {
  data: Uint8Array<ArrayBuffer>;
  mime: "video/webm" | "image/gif" | "image/png";
  fellBack: boolean;
}

function toStickerFile(c: Converted): StickerFile {
  return { data: c.data, format: c.mime === "video/webm" ? "video" : "static" };
}

async function convertOne(
  dir: string,
  stickerId: number,
  index: number,
  animated: boolean,
  target: Target,
): Promise<Converted> {
  const base = join(dir, String(index));
  if (animated && (await download(animationUrl(stickerId), `${base}.apng`))) {
    try {
      return target === "telegram"
        ? { mime: "video/webm", data: await toVideo(`${base}.apng`, `${base}.webm`), fellBack: false }
        : { mime: "image/gif", data: await toGif(`${base}.apng`, `${base}.gif`), fellBack: false };
    } catch (e) {
      console.warn(`sticker #${index}: animation failed, using static (${String(e)})`);
    }
  }
  const src = `${base}.src.png`;
  if (!(await download(staticUrl(stickerId), src))) {
    throw new Error(`sticker #${index}: no image on CDN`);
  }
  if (isCgbi(await readFile(src)) && !(await download(androidStaticUrl(stickerId), src))) {
    throw new Error(`sticker #${index}: CgBI PNG and no android fallback`);
  }
  // The web page shows LINE's own PNG; Telegram needs it at 512 px.
  const data = target === "telegram" ? await toStatic(src, `${base}.png`) : new Uint8Array(await readFile(src));
  return { mime: "image/png", data, fellBack: animated };
}

async function convertAll(
  meta: LineStickerMeta,
  from: number,
  to: number,
  dir: string,
  target: Target,
): Promise<Converted[]> {
  const animated = isAnimated(meta);
  const out: Converted[] = new Array(to - from);
  let next = from;
  async function worker(): Promise<void> {
    while (next < to) {
      const i = next++;
      out[i - from] = await convertOne(dir, meta.stickers[i]!.id, i, animated, target);
    }
  }
  await Promise.all(Array.from({ length: CONVERT_CONCURRENCY }, worker));
  console.log(`converted ${to - from} stickers`);
  return out;
}
async function withFloodRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof TelegramError) || e.code !== 429 || attempt >= 5) throw e;
      const wait = (e.retryAfter ?? 5) + 1;
      console.log(`flood wait ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function dryRun(meta: LineStickerMeta, outDir: string, target: Target): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const converted = await convertAll(meta, 0, Math.min(meta.stickers.length, SET_MAX), outDir, target);
  const fell = converted.filter((c) => c.fellBack).length;
  const kb = converted.map((c) => Math.round(c.data.byteLength / 1024));
  console.log(`dry run: ${converted.length} files in ${outDir}, max ${Math.max(...kb)} KB, ${fell} fell back`);
}

async function importPack(inputs: Inputs, meta: LineStickerMeta, token: string, owner: string) {
  const { productId } = inputs;
  const title = pickTitle(meta);
  const name = stickerSetName(productId, await getBotUsername(token));
  const total = Math.min(meta.stickers.length, SET_MAX);
  const dir = await mkdtemp(join(tmpdir(), "linesticker-"));

  let done = (await getStickerSet(token, name))?.stickers.length ?? 0;
  console.log(`have ${done}/${total}`);
  const converted = done < total ? await convertAll(meta, done, total, dir, "telegram") : [];
  const fellBack = converted.filter((c) => c.fellBack).length;

  let pending = converted;
  if (done === 0 && pending.length) {
    const batch = pending.slice(0, CREATE_BATCH_MAX);
    await withFloodRetry(() =>
      createNewStickerSet(token, { userId: owner, name, title, stickers: batch.map(toStickerFile) }),
    );
    done += batch.length;
    pending = pending.slice(batch.length);
    console.log(`created set with ${batch.length}`);
  }
  for (const c of pending) {
    await withFloodRetry(() => addStickerToSet(token, { userId: owner, name, sticker: toStickerFile(c) }));
    done++;
  }
  console.log(`set complete: ${done}/${total}`);

  const set = await getStickerSet(token, name);
  const first = set?.stickers[0];
  if (!first) throw new Error("set missing after import");
  await dropProgress(token, owner, inputs);
  await sendSticker(token, {
    chatId: owner,
    fileId: first.file_id,
    replyMarkup: addSetKeyboard(addStickersUrl(name), title, set.stickers.length),
  });
  const notes: string[] = [];
  if (meta.stickers.length > SET_MAX) notes.push(`一个贴纸集最多 ${SET_MAX} 张，只导入了前 ${SET_MAX} 张（共 ${meta.stickers.length} 张）`);
  if (fellBack) notes.push(`${fellBack} 张动态贴纸转换失败，已改为静态`);
  if (notes.length) await sendMessage(token, { chatId: owner, text: `ℹ️ ${notes.join("；")}` });
}

interface WebConfig {
  base: string;
  secret: string;
}

async function webPut(web: WebConfig, path: string, body: BodyInit, type: string): Promise<void> {
  const res = await fetch(`${web.base}/wx/${path}`, {
    method: "PUT",
    headers: { "x-import-secret": web.secret, "content-type": type },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`web put ${res.status}`);
}

const putStatus = (web: WebConfig, id: string, update: Record<string, unknown>) =>
  webPut(web, id, JSON.stringify(update), "application/json");

const PROGRESS_EVERY = 5;

// Resumes from the count the page already has; images are PUT in order.
async function importWeb(inputs: Inputs, meta: LineStickerMeta, web: WebConfig): Promise<void> {
  const id = inputs.productId;
  const res = await fetch(`${web.base}/wx/${id}?json`, { signal: AbortSignal.timeout(15_000) });
  const pack = (await res.json()) as { status: string; count: number } | null;
  if (!pack) throw new Error("no web pack; the Worker creates it on request");
  const total = Math.min(meta.stickers.length, SET_MAX);
  let done = pack.status === "ready" ? total : pack.count;
  console.log(`web have ${done}/${total}`);
  if (done >= total) return;

  const dir = await mkdtemp(join(tmpdir(), "linesticker-web-"));
  const converted = await convertAll(meta, done, total, dir, "wechat");
  for (const c of converted) {
    await webPut(web, `${id}/${done}`, c.data, c.mime);
    done++;
    if (done % PROGRESS_EVERY === 0 && done < total) await putStatus(web, id, { count: done });
  }
  await putStatus(web, id, { status: "ready", count: done });
  console.log(`web complete: ${done}/${total}`);
}

async function main(): Promise<void> {
  const inputs = readInputs();
  const meta = await fetchMeta(inputs.productId);
  if (!meta) throw new Error("pack not found on LINE CDN");

  const dryDir = process.env.DRY_RUN_DIR;
  if (dryDir) return dryRun(meta, dryDir, inputs.target);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const owner = process.env.TELEGRAM_OWNER_ID;
  if (!token || !owner) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID not set");
  const webBase = process.env.LINESTICKER_URL;
  const webSecret = process.env.LINESTICKER_IMPORT_SECRET;
  const web = webBase && webSecret ? { base: webBase, secret: webSecret } : null;
  try {
    if (inputs.target === "wechat") {
      if (!web) throw new Error("LINESTICKER_URL / LINESTICKER_IMPORT_SECRET not set");
      await importWeb(inputs, meta, web);
    } else {
      await importPack(inputs, meta, token, owner);
    }
  } catch (e) {
    if (inputs.target === "wechat" && web) await putStatus(web, inputs.productId, { status: "failed" }).catch(() => {});
    await dropProgress(token, owner, inputs);
    await sendMessage(token, {
      chatId: owner,
      parseMode: "HTML",
      text: `⚠️ <b>${escapeHtml(pickTitle(meta))}</b> ${inputs.target === "wechat" ? "微信页面" : ""}导入失败：${escapeHtml(String(e).slice(0, 500))}\n重新发送链接即可从中断处继续。`,
    }).catch(() => {});
    throw e;
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
