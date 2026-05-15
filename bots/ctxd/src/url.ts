export type SourceType = "slack" | "github" | "jira" | "confluence" | "unknown";

const URL_RE = /https?:\/\/\S+/g;

function cleanUrl(raw: string): string {
  return raw.replace(/^</, "").replace(/>$/, "").replace(/[),.;，。！？!?]+$/g, "");
}

export function extractFirstUrl(text: string): { url?: string; multiple: boolean } {
  const urls = Array.from(text.matchAll(URL_RE), (m) => cleanUrl(m[0])).filter(Boolean);
  if (urls.length === 0) return { multiple: false };
  if (urls.length > 1) return { multiple: true };
  return { url: urls[0], multiple: false };
}

export function detectSourceType(url: string): SourceType {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {
    return "unknown";
  }

  if (host.endsWith("slack.com")) return "slack";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host.endsWith("atlassian.net")) {
    // /wiki/ paths are Confluence; /browse/ paths are Jira
    if (path.startsWith("/wiki/") || path.startsWith("/wiki")) return "confluence";
    if (path.startsWith("/browse/")) return "jira";
    return "jira"; // default for atlassian.net
  }
  if (host.includes("confluence") || path.includes("confluence")) {
    return "confluence";
  }
  return "unknown";
}

export function sourceTypeName(sourceType: SourceType): string {
  switch (sourceType) {
    case "slack":
      return "Slack";
    case "github":
      return "GitHub";
    case "jira":
      return "Jira";
    case "confluence":
      return "Confluence";
    case "unknown":
      return "未知来源";
  }
}
