// LINE PNG / APNG -> Telegram sticker files via ffmpeg.
// Telegram limits: one side exactly 512 px, the other <= 512.
//   static: PNG <= 512 KB
//   video:  WEBM VP9, <= 3 s, <= 30 fps, no audio, <= 256 KB
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const SCALE = "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos";
const STATIC_MAX = 512 * 1024;
const VIDEO_MAX = 256 * 1024;
const MAX_SECONDS = 2.95;
const MAX_FPS = 30;
const CRF_STEPS = [30, 36, 42, 48, 54, 63];

async function ffmpeg(args: string[]): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });
}

async function readSized(path: string, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if ((await stat(path)).size > max) return null;
  return new Uint8Array(await readFile(path));
}

export async function toStatic(input: string, output: string): Promise<Uint8Array<ArrayBuffer>> {
  // -frames:v 1 also flattens an APNG to its first frame.
  await ffmpeg(["-i", input, "-frames:v", "1", "-vf", SCALE, output]);
  const full = await readSized(output, STATIC_MAX);
  if (full) return full;
  // Rare: fall back to an 8-bit palette PNG.
  const vf = `${SCALE},split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse`;
  await ffmpeg(["-i", input, "-frames:v", "1", "-filter_complex", vf, output]);
  const small = await readSized(output, STATIC_MAX);
  if (!small) throw new Error("static sticker over 512 KB");
  return small;
}

// APNG frame delays vary, so derive length from the last frame's pts + duration.
async function probeApng(input: string): Promise<{ seconds: number; delaysMs: number[] }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-f", "apng", "-show_entries", "frame=pts_time,duration_time",
    "-of", "csv=p=0", input,
  ]);
  const rows = stdout.trim().split("\n").filter(Boolean).map((r) => r.split(",").map(Number));
  const [pts, dur] = rows.at(-1) ?? [];
  const seconds = (pts ?? 0) + (dur ?? 0);
  if (!rows.length || !(seconds > 0)) throw new Error("apng probe failed");
  return { seconds, delaysMs: rows.map(([, d]) => Math.round((d ?? 0) * 1000)) };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// Telegram clients play video stickers at the header frame rate and ignore
// per-frame durations, so a VFR encode loses LINE's long holds. Emit CFR at
// the delays' common tick (holds become repeated frames), capped at 30 fps.
export function cfrRate(delaysMs: number[], speedup: number): string {
  const tick = delaysMs.filter((d) => d > 0).reduce(gcd, 0);
  if (speedup !== 1 || !tick || 1000 / tick > MAX_FPS) return String(MAX_FPS);
  return `1000/${tick}`;
}

export async function toVideo(input: string, output: string): Promise<Uint8Array<ArrayBuffer>> {
  const { seconds, delaysMs } = await probeApng(input);
  const factor = seconds > MAX_SECONDS ? MAX_SECONDS / seconds : 1;
  const filters = [
    `setpts=PTS*${factor.toFixed(4)}`,
    `fps=${cfrRate(delaysMs, factor)}`,
    SCALE,
  ];

  for (const crf of CRF_STEPS) {
    await ffmpeg([
      "-f", "apng", "-i", input, "-vf", filters.join(","), "-an",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", String(crf),
      output,
    ]);
    const data = await readSized(output, VIDEO_MAX);
    if (data) return data;
  }
  throw new Error("video sticker over 256 KB at max crf");
}

// WeChat page: GIF keeps the APNG's own frame delays (GIF stores per-frame
// delays natively), no length cap. Shrink until it fits WeChat's custom
// sticker limit so a forwarded GIF can also be saved as a sticker.
const GIF_MAX = 1024 * 1024;
const GIF_SIDES = [240, 200, 160];

export async function toGif(input: string, output: string): Promise<Uint8Array<ArrayBuffer>> {
  for (const side of GIF_SIDES) {
    const scale = `scale=${side}:${side}:force_original_aspect_ratio=decrease:flags=lanczos`;
    const vf = `${scale},split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];` +
      "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle:alpha_threshold=128";
    await ffmpeg(["-f", "apng", "-i", input, "-filter_complex", vf, "-loop", "0", output]);
    const data = await readSized(output, GIF_MAX);
    if (data) return data;
  }
  throw new Error("gif over 1 MB at smallest size");
}

// WeChat page, static sticker: a forwarded PNG is re-encoded as JPEG (white
// background), a forwarded GIF is kept as a sticker with its transparency.
// One frame at LINE's own size (~370 px) is far under GIF_MAX.
export async function toStaticGif(input: string, output: string): Promise<Uint8Array<ArrayBuffer>> {
  const vf = "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128";
  await ffmpeg(["-i", input, "-frames:v", "1", "-filter_complex", vf, output]);
  const data = await readSized(output, GIF_MAX);
  if (!data) throw new Error("static gif over 1 MB");
  return data;
}
