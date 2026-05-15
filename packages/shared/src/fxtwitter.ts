const STATUS_RE =
  /(?:^|\s)https?:\/\/(?:[\w.-]*\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:[^/\s]+\/)?(?:i\/web\/)?status(?:es)?\/(\d+)/i;

export function extractStatusId(text: string): string | null {
  const m = text.match(STATUS_RE);
  return m ? m[1]! : null;
}

interface FxVideo {
  url: string;
  thumbnail_url?: string;
  duration?: number;
  width?: number;
  height?: number;
  filesize?: number;
  format?: string;
  formats?: FxVideoFormat[];
}

interface FxVideoFormat {
  container?: string;
  codec?: string;
  bitrate?: number;
  url: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface FxAuthor {
  name?: string;
  screen_name?: string;
}

export interface FxTweet {
  id: string;
  url?: string;
  text?: string;
  author?: FxAuthor;
  media?: { videos?: FxVideo[] };
}

interface FxResponse {
  code: number;
  message?: string;
  status?: FxTweet;
  tweet?: FxTweet;
}

export interface SelectedVideo {
  url: string;
  thumbnail_url?: string;
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
  bitrate?: number;
  container?: string;
}

export type FetchResult =
  | { kind: "video"; candidates: SelectedVideo[]; tweet: FxTweet }
  | { kind: "novideo"; tweet: FxTweet }
  | { kind: "error"; reason: string };

function isMp4Url(url: string): boolean {
  return /\.mp4(?:[?#]|$)/i.test(url);
}

function isM3u8Url(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url);
}

function candidateScore(v: SelectedVideo): number {
  return (
    (v.bitrate ?? 0) * 100_000_000 +
    (v.height ?? 0) * 100_000 +
    (v.width ?? 0) * 100 +
    (v.size ?? 0)
  );
}

export function selectVideos(videos: FxVideo[]): SelectedVideo[] {
  const candidates: SelectedVideo[] = [];

  for (const video of videos) {
    for (const format of video.formats ?? []) {
      const container = format.container?.toLowerCase();
      const isMp4 = container === "mp4" || isMp4Url(format.url);
      if (!isMp4) continue;
      candidates.push({
        url: format.url,
        thumbnail_url: video.thumbnail_url,
        duration: video.duration,
        width: format.width ?? video.width,
        height: format.height ?? video.height,
        size: format.size,
        bitrate: format.bitrate,
        container: container ?? "mp4",
      });
    }

    if (
      isMp4Url(video.url) ||
      (video.format?.toLowerCase().includes("mp4") && !isM3u8Url(video.url))
    ) {
      candidates.push({
        url: video.url,
        thumbnail_url: video.thumbnail_url,
        duration: video.duration,
        width: video.width,
        height: video.height,
        size: video.filesize,
        container: "mp4",
      });
    }
  }

  return candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
}

export async function fetchTweet(statusId: string): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.fxtwitter.com/2/status/${statusId}`, {
      headers: { "user-agent": "cc-xvideo-bot/0.1" },
    });
  } catch (e) {
    return { kind: "error", reason: `network: ${(e as Error).message}` };
  }
  if (!res.ok) return { kind: "error", reason: `fxtwitter ${res.status}` };

  const data = (await res.json()) as FxResponse;
  const tweet = data.status ?? data.tweet;
  if (data.code !== 200 || !tweet) {
    return { kind: "error", reason: data.message ?? `code ${data.code}` };
  }
  const candidates = selectVideos(tweet.media?.videos ?? []);
  if (!candidates.length) return { kind: "novideo", tweet };
  return { kind: "video", candidates, tweet };
}
