// Weibo post video extraction.
// Flow: visitor session (genvisitor → incarnate) → ajax statuses/show → playback_list mp4 URLs.
// Video CDN requires Referer: https://weibo.com/ header on download.

const WEIBO_URL_RE =
  /(?:^|\s)https?:\/\/(?:m\.weibo\.cn\/(?:status|detail)|(?:www\.)?weibo\.com\/\d+|weibo\.com\/detail)\/([a-zA-Z0-9]+)/i;

export function extractWeiboId(text: string): string | null {
  const m = text.match(WEIBO_URL_RE);
  return m ? m[1]! : null;
}

interface WeiboPlayInfo {
  url: string;
  mime?: string;
  label?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  size?: number;
  fps?: number;
  duration?: number;
  video_codecs?: string;
  audio_codecs?: string;
}

interface WeiboPlaybackEntry {
  meta?: { label?: string; quality_label?: string };
  play_info?: WeiboPlayInfo;
}

interface WeiboMediaInfo {
  playback_list?: WeiboPlaybackEntry[];
  stream_url?: string;
  stream_url_hd?: string;
  mp4_sd_url?: string;
  mp4_hd_url?: string;
  format?: string;
  duration?: number;
}

interface WeiboMixMediaItem {
  type: string;
  id: string;
  data?: {
    object_id?: string;
    media_info?: WeiboMediaInfo;
  };
}

interface WeiboUser {
  id?: number;
  idstr?: string;
  screen_name?: string;
  profile_url?: string;
}

interface WeiboPostJson {
  id?: number;
  idstr?: string;
  mblogid?: string;
  text_raw?: string;
  text?: string;
  user?: WeiboUser;
  page_info?: { media_info?: WeiboMediaInfo };
  mix_media_info?: { items?: WeiboMixMediaItem[] };
}

export interface WeiboVideo {
  url: string;
  width?: number;
  height?: number;
  size?: number;
  bitrate?: number;
  duration?: number;
  label?: string;
}

export interface WeiboPost {
  mblogid?: string;
  text?: string;
  author?: string;
  videos: WeiboVideo[];
}

export type WeiboFetchResult =
  | { kind: "video"; post: WeiboPost }
  | { kind: "novideo"; post: WeiboPost }
  | { kind: "error"; reason: string };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseJsonp(text: string): unknown {
  // Responses look like: window.gen_callback && gen_callback({...});
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("jsonp: no JSON object found");
  return JSON.parse(m[0]!);
}

function extractCookie(setCookie: string[], name: string): string | undefined {
  for (const sc of setCookie) {
    const m = sc.match(new RegExp(`${name}=([^;]+)`, "i"));
    if (m) return m[1]!;
  }
  return undefined;
}

interface VisitorCookies {
  sub: string;
  subp: string;
}

async function getVisitorCookies(
  fetcher: typeof fetch,
  videoId: string,
): Promise<VisitorCookies> {
  const fp = JSON.stringify({
    os: "1",
    browser: "Chrome120,0,0,0",
    fonts: "undefined",
    screenInfo: "1920*1080*24",
    plugins: "",
  });

  const genRes = await fetcher("https://passport.weibo.com/visitor/genvisitor", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA,
      referer: "https://weibo.com/",
    },
    body: `cb=gen_callback&fp=${encodeURIComponent(fp)}`,
    signal: AbortSignal.timeout(15_000),
  });
  if (!genRes.ok) throw new Error(`genvisitor http ${genRes.status}`);

  const genData = parseJsonp(await genRes.text()) as {
    data?: { tid?: string; new_tid?: boolean; confidence?: number };
  };
  const tid = genData.data?.tid;
  if (!tid) throw new Error("genvisitor: no tid");
  const w = genData.data?.new_tid ? 3 : 2;
  const c = String(genData.data?.confidence ?? 100).padStart(3, "0");

  const incRes = await fetcher(
    `https://passport.weibo.com/visitor/visitor?a=incarnate&t=${tid}&w=${w}&c=${c}&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`,
    {
      headers: { "user-agent": UA, referer: "https://weibo.com/" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!incRes.ok) throw new Error(`incarnate http ${incRes.status}`);

  // Headers.getSetCookie() is not in the default workers-types; fall back to
  // getSetCookie if available, otherwise parse the combined header.
  const headers = incRes.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length) {
    const sub = extractCookie(setCookies, "SUB");
    const subp = extractCookie(setCookies, "SUBP");
    if (sub && subp) return { sub, subp };
  }
  // Fallback: some runtimes collapse Set-Cookie into a single comma-joined header.
  const raw = incRes.headers.get("set-cookie") ?? "";
  const parts = raw.split(/,(?=\s*\w+=)/);
  const sub = extractCookie(parts, "SUB");
  const subp = extractCookie(parts, "SUBP");
  if (!sub || !subp) throw new Error("incarnate: missing SUB/SUBP cookies");
  return { sub, subp };
}

async function fetchPostJson(
  fetcher: typeof fetch,
  id: string,
  cookies: VisitorCookies,
): Promise<WeiboPostJson> {
  const res = await fetcher(
    `https://weibo.com/ajax/statuses/show?id=${id}&locale=zh_CN`,
    {
      headers: {
        "user-agent": UA,
        referer: "https://weibo.com/",
        cookie: `SUB=${cookies.sub}; SUBP=${cookies.subp}`,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`statuses/show http ${res.status}`);
  return (await res.json()) as WeiboPostJson;
}

function selectBestVideo(mi: WeiboMediaInfo): WeiboVideo | null {
  const candidates: WeiboVideo[] = [];
  for (const entry of mi.playback_list ?? []) {
    const pi = entry.play_info;
    if (!pi?.url) continue;
    if (pi.mime && !pi.mime.includes("mp4")) continue;
    candidates.push({
      url: pi.url,
      width: pi.width,
      height: pi.height,
      size: pi.size,
      bitrate: pi.bitrate,
      duration: pi.duration,
      label: pi.label ?? entry.meta?.quality_label,
    });
  }
  if (candidates.length) {
    return candidates.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]!;
  }
  // Fallback: stream_url fields if playback_list was empty
  for (const url of [mi.stream_url_hd, mi.stream_url, mi.mp4_hd_url, mi.mp4_sd_url]) {
    if (url && /\.mp4/i.test(url)) {
      return { url, duration: mi.duration };
    }
  }
  return null;
}

function parsePost(json: WeiboPostJson): WeiboPost {
  const author = json.user?.screen_name;
  const text = json.text_raw ?? json.text ?? "";
  const mblogid = json.mblogid;

  // Multi-video post: mix_media_info.items[]
  if (json.mix_media_info?.items?.length) {
    const videos: WeiboVideo[] = [];
    for (const item of json.mix_media_info.items) {
      if (item.type === "pic" || !item.data?.media_info) continue;
      const v = selectBestVideo(item.data.media_info);
      if (v) videos.push(v);
    }
    return { mblogid, text, author, videos };
  }

  // Single-video post: page_info.media_info
  const mi = json.page_info?.media_info;
  if (mi) {
    const v = selectBestVideo(mi);
    return { mblogid, text, author, videos: v ? [v] : [] };
  }

  return { mblogid, text, author, videos: [] };
}

export async function fetchWeiboPost(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<WeiboFetchResult> {
  let cookies: VisitorCookies;
  try {
    cookies = await getVisitorCookies(fetcher, id);
  } catch (e) {
    return { kind: "error", reason: `visitor: ${(e as Error).message}` };
  }

  let json: WeiboPostJson;
  try {
    json = await fetchPostJson(fetcher, id, cookies);
  } catch (e) {
    return { kind: "error", reason: `fetch: ${(e as Error).message}` };
  }

  if ((json as { error?: string }).error) {
    return { kind: "error", reason: (json as { error: string }).error };
  }

  const post = parsePost(json);
  if (!post.videos.length) return { kind: "novideo", post };
  return { kind: "video", post };
}
