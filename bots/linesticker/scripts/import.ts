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
import { toStatic, toVideo } from "./convert.ts";

const CONVERT_CONCURRENCY = 4;

interface Inputs {
  productId: string;
  // The Worker's "importing" message; deleted before the result is sent.
  progressMessageId?: number;
}

function readInputs(): Inputs {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const inputs = eventPath
    ? JSON.parse(readFileSync(eventPath, "utf8")).inputs ?? {}
    : { product_id: process.argv[2] };
  const id = String(inputs.product_id ?? "").trim();
  if (process.env.GITHUB_ACTIONS && id) console.log(`::add-mask::${id}`);
  if (!/^\d{1,12}$/.test(id)) throw new Error("product_id must be digits");
  const progress = Number(inputs.progress_message_id);
  return { productId: id, progressMessageId: Number.isInteger(progress) && progress > 0 ? progress : undefined };
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
  file: StickerFile;
  fellBack: boolean;
}

async function convertOne(
  dir: string,
  stickerId: number,
  index: number,
  animated: boolean,
): Promise<Converted> {
  const base = join(dir, String(index));
  if (animated && (await download(animationUrl(stickerId), `${base}.apng`))) {
    try {
      return { file: { format: "video", data: await toVideo(`${base}.apng`, `${base}.webm`) }, fellBack: false };
    } catch (e) {
      console.warn(`sticker #${index}: video failed, using static (${String(e)})`);
    }
  }
  const src = `${base}.src.png`;
  if (!(await download(staticUrl(stickerId), src))) {
    throw new Error(`sticker #${index}: no image on CDN`);
  }
  if (isCgbi(await readFile(src)) && !(await download(androidStaticUrl(stickerId), src))) {
    throw new Error(`sticker #${index}: CgBI PNG and no android fallback`);
  }
  const data = await toStatic(src, `${base}.png`);
  return { file: { format: "static", data }, fellBack: animated };
}

async function convertAll(
  meta: LineStickerMeta,
  from: number,
  to: number,
  dir: string,
): Promise<Converted[]> {
  const animated = isAnimated(meta);
  const out: Converted[] = new Array(to - from);
  let next = from;
  async function worker(): Promise<void> {
    while (next < to) {
      const i = next++;
      out[i - from] = await convertOne(dir, meta.stickers[i]!.id, i, animated);
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

async function dryRun(meta: LineStickerMeta, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const converted = await convertAll(meta, 0, Math.min(meta.stickers.length, SET_MAX), outDir);
  const fell = converted.filter((c) => c.fellBack).length;
  const kb = converted.map((c) => Math.round(c.file.data.byteLength / 1024));
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
  const converted = done < total ? await convertAll(meta, done, total, dir) : [];
  const fellBack = converted.filter((c) => c.fellBack).length;

  let pending = converted;
  if (done === 0 && pending.length) {
    const batch = pending.slice(0, CREATE_BATCH_MAX);
    await withFloodRetry(() =>
      createNewStickerSet(token, { userId: owner, name, title, stickers: batch.map((c) => c.file) }),
    );
    done += batch.length;
    pending = pending.slice(batch.length);
    console.log(`created set with ${batch.length}`);
  }
  for (const c of pending) {
    await withFloodRetry(() => addStickerToSet(token, { userId: owner, name, sticker: c.file }));
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

async function main(): Promise<void> {
  const inputs = readInputs();
  const meta = await fetchMeta(inputs.productId);
  if (!meta) throw new Error("pack not found on LINE CDN");

  const dryDir = process.env.DRY_RUN_DIR;
  if (dryDir) return dryRun(meta, dryDir);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const owner = process.env.TELEGRAM_OWNER_ID;
  if (!token || !owner) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID not set");
  try {
    await importPack(inputs, meta, token, owner);
  } catch (e) {
    await dropProgress(token, owner, inputs);
    await sendMessage(token, {
      chatId: owner,
      parseMode: "HTML",
      text: `⚠️ <b>${escapeHtml(pickTitle(meta))}</b> 导入失败：${escapeHtml(String(e).slice(0, 500))}\n重新发送链接即可从中断处继续。`,
    }).catch(() => {});
    throw e;
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
