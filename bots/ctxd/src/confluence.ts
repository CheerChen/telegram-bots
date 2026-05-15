/** Confluence REST API v2 fetcher for Cloudflare Workers. */

import type { JiraAuth as AtlassianAuth } from "./jira.ts";

export type { AtlassianAuth };

export interface ConfluenceFetchResult {
    markdown: string;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const WIKI_SPACES_RE = /^\/wiki\/spaces\/[^/]+\/pages\/(\d+)/;
const PAGE_ID_QUERY_RE = /[?&]pageId=(\d+)/;
const TRAILING_DIGITS_RE = /\/(\d+)\/?$/;

export function isConfluenceUrl(url: string): boolean {
    try {
        const u = new URL(url);
        const path = u.pathname;
        return (
            (u.hostname.endsWith("atlassian.net") && path.startsWith("/wiki/")) ||
            PAGE_ID_QUERY_RE.test(u.search) ||
            (u.hostname.includes("confluence") && TRAILING_DIGITS_RE.test(path))
        );
    } catch {
        return false;
    }
}

export function parseConfluenceUrl(url: string): { site: string; pageId: string } {
    const u = new URL(url);
    const site = `${u.protocol}//${u.hostname}`;

    // /wiki/spaces/{space}/pages/{pageId}/...
    const spacesMatch = u.pathname.match(WIKI_SPACES_RE);
    if (spacesMatch) return { site, pageId: spacesMatch[1]! };

    // ?pageId=123
    const queryMatch = u.search.match(PAGE_ID_QUERY_RE);
    if (queryMatch) return { site, pageId: queryMatch[1]! };

    // /wiki/.../12345
    const trailingMatch = u.pathname.match(TRAILING_DIGITS_RE);
    if (trailingMatch) return { site, pageId: trailingMatch[1]! };

    throw new Error(`Could not extract pageId from URL: ${url}`);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function authHeader(auth: AtlassianAuth): Record<string, string> {
    const encoded = btoa(`${auth.email}:${auth.apiToken}`);
    return {
        authorization: `Basic ${encoded}`,
        accept: "application/json",
    };
}

interface ConfluencePage {
    id: string;
    title?: string;
    spaceId?: string;
    body?: { storage?: { value?: string } };
    version?: { createdAt?: string; authorId?: string };
}

interface ConfluenceComment {
    title?: string;
    body?: { storage?: { value?: string } };
    version?: { createdAt?: string; authorId?: string };
}

interface PaginatedResponse<T> {
    results: T[];
    _links?: { next?: string };
}

async function getPage(auth: AtlassianAuth, pageId: string): Promise<ConfluencePage> {
    const url = `${auth.baseUrl}/wiki/api/v2/pages/${pageId}?body-format=storage`;
    const res = await fetch(url, { headers: authHeader(auth) });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Confluence API ${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as ConfluencePage;
}

async function getFooterComments(auth: AtlassianAuth, pageId: string): Promise<ConfluenceComment[]> {
    const all: ConfluenceComment[] = [];
    let endpoint: string | null =
        `${auth.baseUrl}/wiki/api/v2/pages/${pageId}/footer-comments?limit=100&body-format=storage`;

    while (endpoint) {
        const res = await fetch(endpoint, { headers: authHeader(auth) });
        if (!res.ok) break;
        const data = (await res.json()) as PaginatedResponse<ConfluenceComment>;
        all.push(...data.results);
        endpoint = data._links?.next ? `${auth.baseUrl}${data._links.next}` : null;
    }
    return all;
}

// ---------------------------------------------------------------------------
// Confluence storage format → readable text
//
// Confluence storage format is Atlassian-specific XHTML with custom tags
// like <ac:structured-macro>, <ac:rich-text-body>, <ri:attachment>, etc.
// We do a pragmatic conversion: strip Atlassian-specific tags, convert
// code macros, then strip remaining HTML → markdown-ish text.
// ---------------------------------------------------------------------------

/** Convert <ac:structured-macro ac:name="code"> to fenced code blocks. */
function convertCodeMacros(html: string): string {
    const re = /<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<\/ac:structured-macro>/gi;
    return html.replace(re, (match) => {
        const langMatch = match.match(/<ac:parameter ac:name="language">([^<]+)<\/ac:parameter>/);
        const lang = langMatch?.[1] ?? "";
        const bodyMatch = match.match(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/);
        if (!bodyMatch) return "";
        let content = bodyMatch[1]!;
        // Strip CDATA wrapper
        if (content.startsWith("<![CDATA[") && content.endsWith("]]>")) {
            content = content.slice(9, -3);
        }
        return `\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
    });
}

/** Strip remaining Atlassian-specific tags but keep their text content. */
function stripAcTags(html: string): string {
    // Remove self-closing AC/RI tags
    let result = html.replace(/<(?:ac|ri):[^>]*\/>/gi, "");
    // Remove AC/RI open/close tags but keep inner content
    result = result.replace(/<\/?(?:ac|ri):[^>]*>/gi, "");
    return result;
}

/** Lightweight HTML → text (same approach as jira.ts). */
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

function convertStorageToText(storageHtml: string): string {
    let html = convertCodeMacros(storageHtml);
    html = stripAcTags(html);
    return stripHtml(html);
}

// ---------------------------------------------------------------------------
// Main fetcher
// ---------------------------------------------------------------------------

const FETCH_MAX_CHARS = 30_000;

export async function fetchConfluencePage(
    auth: AtlassianAuth,
    url: string,
): Promise<ConfluenceFetchResult> {
    const { pageId } = parseConfluenceUrl(url);
    const [page, comments] = await Promise.all([
        getPage(auth, pageId),
        getFooterComments(auth, pageId),
    ]);

    const title = page.title ?? "Untitled";
    const storageHtml = page.body?.storage?.value ?? "";
    const body = convertStorageToText(storageHtml);
    const pageUrl = `${auth.baseUrl}/wiki/spaces/~/pages/${pageId}`;

    const lines: string[] = [
        `# ${title}`,
        "",
        `| Field | Value |`,
        `|-------|-------|`,
        `| Page ID | ${pageId} |`,
        `| URL | ${pageUrl} |`,
        "",
        "## Content",
        "",
        body,
        "",
    ];

    if (comments.length > 0) {
        lines.push("## Comments", "");
        for (const c of comments) {
            const date = c.version?.createdAt ?? "";
            const commentBody = c.body?.storage?.value
                ? convertStorageToText(c.body.storage.value)
                : "";
            lines.push(`### Comment — ${date}`, "", commentBody, "");
        }
    }

    let markdown = lines.join("\n");
    if (markdown.length > FETCH_MAX_CHARS) {
        markdown = markdown.slice(0, FETCH_MAX_CHARS) + "\n\n…(content truncated)";
    }

    return { markdown };
}
