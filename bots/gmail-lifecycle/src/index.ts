// Gmail label lifecycle Worker.
//
// Daily cron orchestrates the full lifecycle:
//   1. Scan inbox for new mail (last 2 days, deduplicated by message ID)
//   2. Wake archived domains that received new mail
//   3. Promote untracked domains meeting the threshold
//   4. Evict: stale active domains -> archive (after confirming the label has
//      no recent mail), stale archived -> delete
//   5. Prune old daily counts
//
// Manual routes (gated by ADMIN_SECRET):
//   POST /run       — run the full cycle immediately. Optional query params:
//                     window=30d      scan "in:inbox newer_than:30d" instead of 2d
//                     max=2000        message IDs to list this invocation
//                     pageToken=...   continue a paged scan (from the previous response)
//                     Cold start = call /run?window=<PROMOTE_WINDOW_DAYS>d and follow
//                     nextPageToken until it is null.
//   POST /migrate   — one-time import of existing Domains/* labels into D1
//   POST /sync      — reconcile D1 state with Gmail (delete leftover labels/filters)
//   GET  /status    — show D1 state summary

import type { D1Database } from "@cloudflare/workers-types";
import type { GmailEnv } from "./gmail";
import { scanInbox, type ScanOptions } from "./scan";
import { promoteDomains } from "./promote";
import { evictDomains } from "./evict";
import { wakeDomains } from "./wake";
import { migrateExistingLabels } from "./migrate";
import { syncToGmail } from "./sync";
import {
  type LifecycleConfig,
  type DomainRow,
  parseConfig,
  pruneDailyCounts,
  pruneScannedMessages,
  getAllDomains,
} from "./lifecycle";

interface Env extends GmailEnv {
  DB: D1Database;
  ADMIN_SECRET?: string;
  // vars
  LABEL_PREFIX?: string;
  ARCHIVE_PREFIX?: string;
  PROMOTE_WINDOW_DAYS?: string;
  PROMOTE_MIN_EMAILS?: string;
  EVICT_ARCHIVE_DAYS?: string;
  EVICT_DELETE_DAYS?: string;
  SCAN_MAX_MESSAGES?: string;
}

const CRON = "0 3 * * *";

interface RunStats {
  scan: {
    listed: number;
    scanned: number;
    skipped: number;
    domainsSeen: number;
    wakeCandidates: string[];
    promoteCandidates: string[];
    nextPageToken: string | null;
  };
  wake: { woken: string[]; failed: string[] };
  promote: { promoted: string[]; failed: string[]; deferred: string[] };
  evict: { refreshed: string[]; archived: string[]; deleted: string[]; failed: string[] };
  errors: string[];
}

async function runCycle(env: Env, cfg: LifecycleConfig, scanOpts: ScanOptions = {}): Promise<RunStats> {
  const stats: RunStats = {
    scan: { listed: 0, scanned: 0, skipped: 0, domainsSeen: 0, wakeCandidates: [], promoteCandidates: [], nextPageToken: null },
    wake: { woken: [], failed: [] },
    promote: { promoted: [], failed: [], deferred: [] },
    evict: { refreshed: [], archived: [], deleted: [], failed: [] },
    errors: [],
  };

  // Phase 1: Scan inbox.
  try {
    const scanResult = await scanInbox(env, env.DB, cfg, scanOpts);
    stats.scan = {
      listed: scanResult.listed,
      scanned: scanResult.scanned,
      skipped: scanResult.skipped,
      domainsSeen: scanResult.domainsSeen,
      wakeCandidates: scanResult.wakeCandidates,
      promoteCandidates: scanResult.promoteCandidates,
      nextPageToken: scanResult.nextPageToken,
    };
    stats.errors.push(...scanResult.errors);
    console.log(`[cycle] scan: ${scanResult.listed} listed, ${scanResult.scanned} scanned, ${scanResult.skipped} skipped, ${scanResult.domainsSeen} domains, ${scanResult.wakeCandidates.length} wake, ${scanResult.promoteCandidates.length} promote`);
  } catch (e) {
    stats.errors.push(`scan: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[cycle] scan failed: ${e}`);
  }

  // Phase 2: Wake archived domains with new mail.
  if (stats.scan.wakeCandidates.length > 0) {
    try {
      const wakeResult = await wakeDomains(env, env.DB, cfg, stats.scan.wakeCandidates);
      stats.wake = { woken: wakeResult.woken, failed: wakeResult.failed };
      stats.errors.push(...wakeResult.errors);
      console.log(`[cycle] wake: ${wakeResult.woken.length} woken, ${wakeResult.failed.length} failed`);
    } catch (e) {
      stats.errors.push(`wake: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`[cycle] wake failed: ${e}`);
    }
  }

  // Phase 3: Promote untracked domains meeting threshold.
  if (stats.scan.promoteCandidates.length > 0) {
    try {
      const promoteResult = await promoteDomains(env, env.DB, cfg, stats.scan.promoteCandidates);
      stats.promote = {
        promoted: promoteResult.promoted,
        failed: promoteResult.failed,
        deferred: promoteResult.deferred,
      };
      stats.errors.push(...promoteResult.errors);
      console.log(`[cycle] promote: ${promoteResult.promoted.length} promoted, ${promoteResult.failed.length} failed, ${promoteResult.deferred.length} deferred`);
    } catch (e) {
      stats.errors.push(`promote: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`[cycle] promote failed: ${e}`);
    }
  }

  // Phase 4: Evict stale domains.
  try {
    const evictResult = await evictDomains(env, env.DB, cfg);
    stats.evict = {
      refreshed: evictResult.refreshed,
      archived: evictResult.archived,
      deleted: evictResult.deleted,
      failed: evictResult.failed,
    };
    stats.errors.push(...evictResult.errors);
    console.log(`[cycle] evict: ${evictResult.refreshed.length} refreshed, ${evictResult.archived.length} archived, ${evictResult.deleted.length} deleted`);
  } catch (e) {
    stats.errors.push(`evict: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[cycle] evict failed: ${e}`);
  }

  // Phase 5: Prune old daily counts and dedup markers.
  try {
    await pruneDailyCounts(env.DB, cfg.promoteWindowDays);
    await pruneScannedMessages(env.DB, cfg.promoteWindowDays);
  } catch (e) {
    stats.errors.push(`prune: ${e instanceof Error ? e.message : String(e)}`);
  }

  return stats;
}

function isAuthorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_SECRET) return false;
  return req.headers.get("x-admin-secret") === env.ADMIN_SECRET;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return json({
        name: "gmail-lifecycle",
        cron: CRON,
        config: parseConfig(env as unknown as Record<string, string>),
      });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      if (!isAuthorized(req, env)) return json({ error: "forbidden" }, 403);
      const domains = await getAllDomains(env.DB);
      const byState = domains.reduce(
        (acc, row) => {
          acc[row.state] = (acc[row.state] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      return json({
        total: domains.length,
        byState,
        recent: domains.slice(0, 20).map((d) => ({
          domain: d.domain,
          state: d.state,
          lastSeen: d.last_seen_at,
          total: d.total_count,
        })),
      });
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (!isAuthorized(req, env)) return json({ error: "forbidden" }, 403);
      const cfg = parseConfig(env as unknown as Record<string, string>);
      const scanOpts: ScanOptions = {};
      const window = url.searchParams.get("window");
      if (window) {
        if (!/^\d+[dmy]$/.test(window)) return json({ error: "window must look like 30d" }, 400);
        scanOpts.query = `in:inbox newer_than:${window}`;
      }
      const max = url.searchParams.get("max");
      if (max) scanOpts.max = parseInt(max, 10);
      const pageToken = url.searchParams.get("pageToken");
      if (pageToken) scanOpts.pageToken = pageToken;
      const stats = await runCycle(env, cfg, scanOpts);
      return json(stats);
    }

    if (req.method === "POST" && url.pathname === "/migrate") {
      if (!isAuthorized(req, env)) return json({ error: "forbidden" }, 403);
      const cfg = parseConfig(env as unknown as Record<string, string>);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "40", 10);
      const result = await migrateExistingLabels(env, env.DB, cfg, offset, limit);
      return json(result);
    }

    if (req.method === "POST" && url.pathname === "/sync") {
      if (!isAuthorized(req, env)) return json({ error: "forbidden" }, 403);
      const cfg = parseConfig(env as unknown as Record<string, string>);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const result = await syncToGmail(env, env.DB, cfg, offset, limit);
      return json(result);
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cfg = parseConfig(env as unknown as Record<string, string>);
    ctx.waitUntil(
      runCycle(env, cfg)
        .then(async (stats) => {
          // Log summary; alert on errors.
          const totalErrors = stats.errors.length;
          if (totalErrors > 0) {
            console.error(`[cron] completed with ${totalErrors} errors:\n${stats.errors.join("\n")}`);
          }
          console.log(
            `[cron] scan=${stats.scan.scanned} skipped=${stats.scan.skipped} wake=${stats.wake.woken.length} ` +
            `promote=${stats.promote.promoted.length} ` +
            `archive=${stats.evict.archived.length} delete=${stats.evict.deleted.length}`,
          );
        })
        .catch((error) => console.error(`[cron] cycle failed: ${error}`)),
    );
  },
};
