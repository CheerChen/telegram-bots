import { isMp4 } from "./select.ts";

export async function probeLineVideoUrl(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  let res: Response;
  try {
    res = await fetcher(url, { method: "HEAD", redirect: "follow" });
  } catch {
    return false;
  }
  if (!res.ok) return false;

  const raw = (res.headers.get("content-type") ?? "").toLowerCase();
  const type = raw.split(";", 1)[0]?.trim() ?? "";
  if (type.startsWith("video/")) return true;
  // Twitter CDN sometimes returns application/octet-stream for .mp4
  if ((!type || type === "application/octet-stream") && isMp4(res.url || url)) return true;
  return false;
}
