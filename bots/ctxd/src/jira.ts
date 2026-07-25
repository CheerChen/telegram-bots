/** Jira REST API v2 fetcher for Cloudflare Workers. */

export interface JiraAuth {
    baseUrl: string; // https://xxx.atlassian.net
    email: string;
    apiToken: string;
}

export interface JiraFetchResult {
    markdown: string;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const BROWSE_RE = /^\/browse\/([A-Z][A-Z0-9_]+-\d+)/i;

export function isJiraUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.hostname.endsWith("atlassian.net") && BROWSE_RE.test(u.pathname);
    } catch {
        return false;
    }
}

export function parseJiraUrl(url: string): { site: string; issueKey: string } {
    const u = new URL(url);
    const match = u.pathname.match(BROWSE_RE);
    if (!match) throw new Error(`Invalid Jira URL: ${url}`);
    return {
        site: `${u.protocol}//${u.hostname}`,
        issueKey: match[1]!,
    };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function authHeader(auth: JiraAuth): Record<string, string> {
    const encoded = btoa(`${auth.email}:${auth.apiToken}`);
    return {
        authorization: `Basic ${encoded}`,
        accept: "application/json",
    };
}

interface JiraIssueResponse {
    key: string;
    fields: Record<string, unknown>;
    renderedFields?: Record<string, unknown>;
    names?: Record<string, string>;
}

interface JiraComment {
    author?: { displayName?: string };
    created?: string;
    renderedBody?: string;
    body?: string;
}

interface JiraCommentsPage {
    comments: JiraComment[];
    total: number;
}

async function getIssue(auth: JiraAuth, issueKey: string): Promise<JiraIssueResponse> {
    const url = `${auth.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}?expand=renderedFields,names`;
    const res = await fetch(url, { headers: authHeader(auth), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Jira API ${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as JiraIssueResponse;
}

async function getComments(auth: JiraAuth, issueKey: string): Promise<JiraComment[]> {
    const all: JiraComment[] = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
        const url =
            `${auth.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment` +
            `?startAt=${startAt}&maxResults=${maxResults}&expand=renderedBody`;
        const res = await fetch(url, { headers: authHeader(auth), signal: AbortSignal.timeout(20_000) });
        if (!res.ok) break;
        const page = (await res.json()) as JiraCommentsPage;
        all.push(...page.comments);
        startAt += page.comments.length;
        if (startAt >= page.total || page.comments.length === 0) break;
    }

    return all;
}

// ---------------------------------------------------------------------------
// HTML → plain-ish text (lightweight, no DOM parser needed in Workers)
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<\/h[1-6]>/gi, "\n\n")
        .replace(/<h([1-6])[^>]*>/gi, (_, level) => "#".repeat(Number(level)) + " ")
        .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
        .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
        .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function nested(obj: unknown, key: string): string {
    if (obj && typeof obj === "object" && key in obj) {
        return String((obj as Record<string, unknown>)[key] ?? "");
    }
    return "";
}

function displayName(obj: unknown): string {
    return nested(obj, "displayName") || nested(obj, "name") || "Unknown";
}

const FETCH_MAX_CHARS = 100_000;

export async function fetchJiraIssue(auth: JiraAuth, url: string): Promise<JiraFetchResult> {
    const { site, issueKey } = parseJiraUrl(url);
    const [issue, comments] = await Promise.all([
        getIssue(auth, issueKey),
        getComments(auth, issueKey),
    ]);

    const f = issue.fields;
    const r = issue.renderedFields ?? {};

    const summary = String(f.summary ?? "Untitled");
    const status = nested(f.status, "name");
    const priority = nested(f.priority, "name");
    const issueType = nested(f.issuetype, "name");
    const assignee = displayName(f.assignee);
    const reporter = displayName(f.reporter);
    const labels = (f.labels as string[]) ?? [];
    const created = String(f.created ?? "");
    const updated = String(f.updated ?? "");
    const issueUrl = `${site}/browse/${issueKey}`;

    // Description: prefer rendered HTML → text, fallback to plain field
    const descHtml = r.description as string | undefined;
    const description = descHtml ? stripHtml(descHtml) : String(f.description ?? "(No description)");

    const lines: string[] = [
        `# [${issueKey}] ${summary}`,
        "",
        "## Metadata",
        "",
        `| Field | Value |`,
        `|-------|-------|`,
        `| Type | ${issueType} |`,
        `| Status | ${status} |`,
        `| Priority | ${priority} |`,
        `| Assignee | ${assignee} |`,
        `| Reporter | ${reporter} |`,
        `| Labels | ${labels.join(", ") || "None"} |`,
        `| Created | ${created} |`,
        `| Updated | ${updated} |`,
        `| URL | ${issueUrl} |`,
        "",
        "## Description",
        "",
        description,
        "",
    ];

    if (comments.length > 0) {
        lines.push("## Comments", "");
        for (const c of comments) {
            const author = displayName(c.author);
            const date = c.created ?? "";
            const body = c.renderedBody ? stripHtml(c.renderedBody) : (c.body ?? "");
            lines.push(`### ${author} — ${date}`, "", body, "");
        }
    }

    let markdown = lines.join("\n");
    if (markdown.length > FETCH_MAX_CHARS) {
        markdown = markdown.slice(0, FETCH_MAX_CHARS) + "\n\n…(content truncated)";
    }

    return { markdown };
}
