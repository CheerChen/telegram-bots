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
async function probeApng(input: string): Promise<{ seconds: number; frames: number }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-f", "apng", "-show_entries", "frame=pts_time,duration_time",
    "-of", "csv=p=0", input,
  ]);
  const rows = stdout.trim().split("\n").filter(Boolean);
  const [pts, dur] = (rows.at(-1) ?? "").split(",").map(Number);
  const seconds = (pts ?? 0) + (dur ?? 0);
  if (!rows.length || !(seconds > 0)) throw new Error("apng probe failed");
  return { seconds, frames: rows.length };
}

export async function toVideo(input: string, output: string): Promise<Uint8Array<ArrayBuffer>> {
  const { seconds, frames } = await probeApng(input);
  const factor = seconds > MAX_SECONDS ? MAX_SECONDS / seconds : 1;
  const filters = [`setpts=PTS*${factor.toFixed(4)}`, SCALE];
  if (frames / (seconds * factor) > MAX_FPS) filters.push(`fps=${MAX_FPS}`);

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
