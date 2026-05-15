import { fetchSlackThread, isSlackUrl } from "./slack.ts";
import { detectSourceType, type SourceType } from "./url.ts";

export class UnsupportedSourceError extends Error {
  constructor(url: string) {
    super(`unsupported source: ${url}`);
    this.name = "UnsupportedSourceError";
  }
}

export interface FetchContextResult {
  markdown: string;
  sourceType: SourceType;
}

export async function fetchContext(slackToken: string, url: string): Promise<FetchContextResult> {
  const sourceType = detectSourceType(url);
  if (!isSlackUrl(url)) throw new UnsupportedSourceError(url);

  // Worker v1 keeps the ctxd boundary but uses the existing Slack fetcher.
  // A CLI-backed service can replace this function later without touching UI flow.
  const fetched = await fetchSlackThread(slackToken, url);
  return {
    markdown: fetched.markdown,
    sourceType,
  };
}
