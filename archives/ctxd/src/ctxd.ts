import { fetchConfluencePage, isConfluenceUrl } from "./confluence.ts";
import { fetchJiraIssue, isJiraUrl, type JiraAuth } from "./jira.ts";
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

export interface FetchContextEnv {
  slackToken: string;
  atlassianAuth?: JiraAuth;
}

export async function fetchContext(env: FetchContextEnv, url: string): Promise<FetchContextResult> {
  const sourceType = detectSourceType(url);

  if (isSlackUrl(url)) {
    const fetched = await fetchSlackThread(env.slackToken, url);
    return { markdown: fetched.markdown, sourceType };
  }

  if (isJiraUrl(url)) {
    if (!env.atlassianAuth) throw new UnsupportedSourceError(url);
    const fetched = await fetchJiraIssue(env.atlassianAuth, url);
    return { markdown: fetched.markdown, sourceType };
  }

  if (isConfluenceUrl(url)) {
    if (!env.atlassianAuth) throw new UnsupportedSourceError(url);
    const fetched = await fetchConfluencePage(env.atlassianAuth, url);
    return { markdown: fetched.markdown, sourceType };
  }

  throw new UnsupportedSourceError(url);
}
