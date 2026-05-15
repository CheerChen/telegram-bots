import type { SelectedVideo } from "shared/fxtwitter";

export const LINE_MAX_DURATION_S = 60;
export const LINE_MAX_BYTES = 200 * 1024 * 1024;

const MP4_RE = /\.mp4(?:[?#]|$)/i;

export function isMp4(url: string): boolean {
  return MP4_RE.test(url);
}

export function isLineCompatible(v: SelectedVideo): boolean {
  if (!isMp4(v.url)) return false;
  if (v.duration !== undefined && v.duration > LINE_MAX_DURATION_S) return false;
  if (v.size !== undefined && v.size > LINE_MAX_BYTES) return false;
  if (!v.thumbnail_url) return false;
  return true;
}

export function pickLineVideo(candidates: SelectedVideo[]): SelectedVideo | null {
  for (const v of candidates) {
    if (isLineCompatible(v)) return v;
  }
  return null;
}

export function pickFallbackThumbnail(
  candidates: SelectedVideo[],
): { url: string; width?: number; height?: number } | null {
  const withThumb = candidates.find((v) => v.thumbnail_url);
  if (!withThumb) return null;
  return {
    url: withThumb.thumbnail_url!,
    width: withThumb.width,
    height: withThumb.height,
  };
}

export function unplayableReason(candidates: SelectedVideo[]): string {
  if (!candidates.length) return "No usable video stream.";
  const first = candidates[0]!;
  if (first.duration !== undefined && first.duration > LINE_MAX_DURATION_S) {
    return `Video is ${Math.round(first.duration)}s — LINE only inlines up to ${LINE_MAX_DURATION_S}s.`;
  }
  if (!candidates.some((v) => isMp4(v.url))) {
    return "Only HLS available — LINE doesn't inline HLS.";
  }
  return "Video can't be inlined on LINE.";
}
