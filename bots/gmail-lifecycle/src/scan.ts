// Inbox scanner.
//
// Lists inbox messages in a time window, fetches their From header via the
// Gmail batch endpoint (50 messages per subrequest), aggregates per sender
// domain, and commits the result to D1 in one batch. Detects:
//   - archived domains with new mail -> wake candidates
//   - untracked domains whose window count meets the threshold -> promote
//
// Dedup: every message ID that has been counted is stored in
// scanned_messages, so overlapping windows (the daily newer_than:2d query, a
// wide cold-start query, or a manual re-run) never count a message twice.
// Daily counts are bucketed by the message's own date (internalDate), not by
// the day the scan happened to run.
//
// Paging: the caller may pass a pageToken and gets nextPageToken back, so a
// cold-start scan over the whole promotion window can be split across several
// invocations without exceeding the per-invocation subrequest limit.

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  type GmailEnv,
  type GmailMessage,
  BATCH_GET_MAX,
  listMessages,
  batchGetMessages,
  getHeader,
  extractDomain,
} from "./gmail";
import {
  type LifecycleConfig,
  normalizeDomain,
  getDomains,
  getPromotionCandidates,
  upsertUntrackedDomainStmt,
  incrementDailyCountStmt,
  touchDomainLastSeenStmt,
  filterUnscannedIds,
  markMessageScannedStmt,
} from "./lifecycle";

export interface ScanOptions {
  /** Gmail search query. Default: "in:inbox newer_than:2d". */
  query?: string;
  /** Max message IDs to list this invocation. Default: cfg.scanMaxMessages. */
  max?: number;
  /** Resume a paged scan from a previous ScanResult.nextPageToken. */
  pageToken?: string;
}

export interface ScanResult {
  listed: number;               // message IDs returned by Gmail search
  scanned: number;              // messages fetched and counted this run
  skipped: number;              // already counted by a previous run
  domainsSeen: number;
  wakeCandidates: string[];     // archived domains that got new mail
  promoteCandidates: string[];  // all untracked domains meeting threshold (not only those seen now)
  nextPageToken: string | null; // non-null when the window has more pages
  errors: string[];
}

interface DomainAgg {
  count: number;
  perDate: Map<string, number>;
  lastSeenIso: string;
}

// D1 batch() is one transaction per call; keep each call bounded in size.
const D1_BATCH_CHUNK = 200;

/** Message timestamp: internalDate is authoritative, Date header is a fallback. */
function messageIso(message: GmailMessage): string {
  if (message.internalDate) {
    const ms = parseInt(message.internalDate, 10);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const dateHeader = getHeader(message, "Date");
  if (dateHeader) {
    const ms = new Date(dateHeader).getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

export async function scanInbox(
  gmailEnv: GmailEnv,
  db: D1Database,
  cfg: LifecycleConfig,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const result: ScanResult = {
    listed: 0,
    scanned: 0,
    skipped: 0,
    domainsSeen: 0,
    wakeCandidates: [],
    promoteCandidates: [],
    nextPageToken: null,
    errors: [],
  };

  const query = opts.query ?? "in:inbox newer_than:2d";
  const max = opts.max ?? cfg.scanMaxMessages;
  let pageToken = opts.pageToken;

  const agg = new Map<string, DomainAgg>();
  const scannedEntries: Array<{ id: string; date: string }> = [];

  // Phase A: list + fetch. Only Gmail calls and read-only D1 lookups here.
  while (result.listed < max) {
    let page;
    try {
      page = await listMessages(gmailEnv, query, Math.min(max - result.listed, 100), pageToken);
    } catch (e) {
      result.errors.push(`listMessages: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    const ids = (page.messages ?? []).map((m) => m.id);
    result.listed += ids.length;
    pageToken = page.nextPageToken;

    if (ids.length) {
      const fresh = await filterUnscannedIds(db, ids);
      result.skipped += ids.length - fresh.length;

      for (let i = 0; i < fresh.length; i += BATCH_GET_MAX) {
        const chunk = fresh.slice(i, i + BATCH_GET_MAX);
        let messages: GmailMessage[];
        try {
          const batch = await batchGetMessages(gmailEnv, chunk, ["From", "Date"]);
          messages = batch.messages;
          result.errors.push(...batch.errors);
        } catch (e) {
          result.errors.push(`batchGetMessages: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }

        for (const message of messages) {
          result.scanned++;
          const iso = messageIso(message);
          // Mark even undecodable messages as scanned so they are not refetched.
          scannedEntries.push({ id: message.id, date: iso.slice(0, 10) });

          const fromHeader = getHeader(message, "From");
          const rawDomain = fromHeader ? extractDomain(fromHeader) : null;
          const domain = rawDomain ? normalizeDomain(rawDomain) : null;
          if (!domain) continue;

          const entry = agg.get(domain) ?? { count: 0, perDate: new Map(), lastSeenIso: iso };
          entry.count++;
          const date = iso.slice(0, 10);
          entry.perDate.set(date, (entry.perDate.get(date) ?? 0) + 1);
          if (iso > entry.lastSeenIso) entry.lastSeenIso = iso;
          agg.set(domain, entry);
        }
      }
    }

    if (!pageToken || !ids.length) break;
  }
  result.nextPageToken = pageToken ?? null;
  result.domainsSeen = agg.size;

  // Phase B: classify domains and build D1 writes.
  const domains = [...agg.keys()];
  const existing = await getDomains(db, domains);
  const stmts: D1PreparedStatement[] = [];

  for (const [domain, entry] of agg) {
    const row = existing.get(domain);
    if (row?.state === "archived") {
      result.wakeCandidates.push(domain);
      stmts.push(touchDomainLastSeenStmt(db, domain, entry.lastSeenIso));
      continue;
    }
    if (row?.state === "active") {
      stmts.push(touchDomainLastSeenStmt(db, domain, entry.lastSeenIso));
      continue;
    }
    stmts.push(upsertUntrackedDomainStmt(db, domain, entry.lastSeenIso, entry.count));
    for (const [date, n] of entry.perDate) {
      stmts.push(incrementDailyCountStmt(db, domain, date, n));
    }
  }
  // Dedup markers go last: if an earlier chunk fails, the run is retried
  // rather than silently losing counts.
  for (const { id, date } of scannedEntries) {
    stmts.push(markMessageScannedStmt(db, id, date));
  }

  for (let i = 0; i < stmts.length; i += D1_BATCH_CHUNK) {
    await db.batch(stmts.slice(i, i + D1_BATCH_CHUNK));
  }

  // Phase C: promotion check over the whole window in D1, so domains whose
  // messages were counted by earlier (paged) runs are not missed.
  result.promoteCandidates = await getPromotionCandidates(
    db,
    cfg.promoteWindowDays,
    cfg.promoteMinEmails,
  );

  return result;
}
