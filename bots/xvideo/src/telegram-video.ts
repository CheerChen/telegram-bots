import type { SelectedVideo } from "shared/fxtwitter";

export const TELEGRAM_REMOTE_VIDEO_MAX_BYTES = 20 * 1024 * 1024;

export interface VideoProbe {
  ok: boolean;
  reason?: string;
}

function isMp4Url(url: string): boolean {
  return /\.mp4(?:[?#]|$)/i.test(url);
}

export function isTelegramSendable(v: SelectedVideo): boolean {
  return v.size === undefined || v.size <= TELEGRAM_REMOTE_VIDEO_MAX_BYTES;
}

function parseTotalBytes(res: Response): number | undefined {
  const range = res.headers.get("content-range");
  const total = range?.match(/\/(\d+)$/)?.[1];
  if (total) return Number.parseInt(total, 10);

  const length = res.headers.get("content-length");
  if (length) return Number.parseInt(length, 10);

  return undefined;
}

function isVideoContentType(contentType: string | null, url: string): boolean {
  if (!contentType) return isMp4Url(url);
  const type = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (type.startsWith("video/")) return true;
  return type === "application/octet-stream" && isMp4Url(url);
}

export async function probeTelegramVideoUrl(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<VideoProbe> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "GET",
      headers: { range: "bytes=0-0", "user-agent": "cc-xvideo-bot/0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, reason: `probe failed: ${(e as Error).message}` };
  }

  if (!res.ok && res.status !== 206) {
    return { ok: false, reason: `probe http ${res.status}` };
  }

  const contentType = res.headers.get("content-type");
  if (!isVideoContentType(contentType, res.url || url)) {
    return { ok: false, reason: `not video content: ${contentType ?? "unknown"}` };
  }

  const totalBytes = parseTotalBytes(res);
  if (totalBytes !== undefined && totalBytes > TELEGRAM_REMOTE_VIDEO_MAX_BYTES) {
    return { ok: false, reason: `video too large: ${totalBytes} bytes` };
  }

  return { ok: true };
}
