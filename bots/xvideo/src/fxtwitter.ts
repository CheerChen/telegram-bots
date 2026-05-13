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
}

interface FxAuthor {
  name?: string;
  screen_name?: string;
}

interface FxTweet {
  id: string;
  url?: string;
  text?: string;
  author?: FxAuthor;
  media?: { videos?: FxVideo[] };
}

interface FxResponse {
  code: number;
  message?: string;
  tweet?: FxTweet;
}

export type FetchResult =
  | { kind: "video"; video: FxVideo; tweet: FxTweet }
  | { kind: "novideo"; tweet: FxTweet }
  | { kind: "error"; reason: string };

export async function fetchTweet(statusId: string): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.fxtwitter.com/i/status/${statusId}`, {
      headers: { "user-agent": "cc-xvideo-bot/0.1" },
    });
  } catch (e) {
    return { kind: "error", reason: `network: ${(e as Error).message}` };
  }
  if (!res.ok) return { kind: "error", reason: `fxtwitter ${res.status}` };

  const data = (await res.json()) as FxResponse;
  if (data.code !== 200 || !data.tweet) {
    return { kind: "error", reason: data.message ?? `code ${data.code}` };
  }
  const video = data.tweet.media?.videos?.[0];
  if (!video) return { kind: "novideo", tweet: data.tweet };
  return { kind: "video", video, tweet: data.tweet };
}
