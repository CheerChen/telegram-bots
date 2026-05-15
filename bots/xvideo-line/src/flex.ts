import type { SelectedVideo } from "shared/fxtwitter";
import type { LineMessageOut } from "shared/line";

const TWITTER_BLUE = "#1DA1F2";
const SUB_COLOR = "#888888";
const DEFAULT_ASPECT = "9:16"; // mobile vertical fallback

const MAX_CAPTION_CHARS = 500;
const MAX_CAPTION_LINES = 6;
const MAX_ALT_TEXT = 400;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectRatio(w?: number, h?: number): string {
  if (!w || !h || w <= 0 || h <= 0) return DEFAULT_ASPECT;
  const g = gcd(w, h);
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

export function truncateCaption(
  text: string,
  maxChars = MAX_CAPTION_CHARS,
  maxLines = MAX_CAPTION_LINES,
): string {
  if (!text) return "";
  let out = text;
  const lines = out.split(/\r?\n/);
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n") + "…";
  }
  if (out.length > maxChars) {
    const slice = out.slice(0, maxChars);
    const lastSpace = slice.search(/\s\S*$/);
    out = (lastSpace > maxChars - 80 ? slice.slice(0, lastSpace) : slice) + "…";
  }
  return out;
}

export function formatVideoCaption(opts: {
  author?: string;
  text?: string;
  video: SelectedVideo;
}): string {
  const { author, text, video } = opts;
  const lines: string[] = [];
  if (author) lines.push(`@${author.replace(/^@/, "")}`);
  const caption = truncateCaption(text ?? "");
  if (caption) lines.push(caption);
  const meta: string[] = [];
  if (video.width && video.height) meta.push(`${video.width}×${video.height}`);
  if (video.duration) meta.push(`${Math.round(video.duration)}s`);
  if (meta.length) lines.push(meta.join(" · "));
  return lines.join("\n");
}

export function buildVideoMessage(video: SelectedVideo): LineMessageOut {
  return {
    type: "video",
    originalContentUrl: video.url,
    previewImageUrl: video.thumbnail_url!,
  };
}

export function buildTweetLinkFlex(opts: {
  author?: string;
  text?: string;
  permalink: string;
  thumbnail: string;
  width?: number;
  height?: number;
  reason: string;
}): LineMessageOut {
  const { author, text, permalink, thumbnail, width, height, reason } = opts;
  const caption = truncateCaption(text ?? "");
  const ratio = aspectRatio(width, height);
  const tapAction = { type: "uri", uri: permalink };

  const bodyContents: unknown[] = [];
  if (author) {
    bodyContents.push({
      type: "text",
      text: `@${author.replace(/^@/, "")}`,
      size: "sm",
      weight: "bold",
      color: TWITTER_BLUE,
      wrap: true,
    });
  }
  if (caption) {
    bodyContents.push({
      type: "text",
      text: caption,
      size: "sm",
      wrap: true,
      margin: "sm",
    });
  }
  bodyContents.push({
    type: "text",
    text: reason,
    size: "xxs",
    color: SUB_COLOR,
    wrap: true,
    margin: "md",
  });

  const altHead = author ? `@${author.replace(/^@/, "")}: ` : "";
  const altText = (altHead + (caption || reason)).slice(0, MAX_ALT_TEXT);

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "mega",
      hero: {
        type: "image",
        url: thumbnail,
        size: "full",
        aspectRatio: ratio,
        aspectMode: "cover",
        action: tapAction,
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: bodyContents,
        action: tapAction,
      },
    },
  };
}
