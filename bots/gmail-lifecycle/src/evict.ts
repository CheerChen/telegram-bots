// Eviction: active -> archived -> deleted.
//
// Phase 1: active domains whose last_seen_at is older than EVICT_ARCHIVE_DAYS
//   (180). Mail from an active domain is filtered out of the inbox on arrival,
//   so the daily inbox scan never sees it and last_seen_at goes stale on its
//   own. Before archiving, ask Gmail whether the label has any message in the
//   last EVICT_ARCHIVE_DAYS (1 subrequest): if yes, refresh last_seen_at and
//   keep the domain active; if no, delete label + filter, set state=archived.
//   The label is removed from Gmail entirely (no _archive namespace).
//   D1 keeps the row so the wake phase can detect new mail and recreate.
//   At most EVICT_BATCH domains are examined per run so a burst of domains
//   reaching the age together (e.g. everything migrated on the same day) is
//   spread over several days instead of exhausting the subrequest budget.
//
// Phase 2: archived domains with no new mail for EVICT_DELETE_DAYS (365)
//   -> delete D1 row (label already gone from Phase 1)

import type { D1Database } from "@cloudflare/workers-types";
import {
  type GmailEnv,
  type GmailLabel,
  listLabels,
  listMessages,
  deleteLabel,
  deleteFilter,
} from "./gmail";
import {
  type LifecycleConfig,
  type DomainRow,
  getDomainsByState,
  updateDomainState,
  deleteDomain,
  touchDomainLastSeenStmt,
  daysSince,
  nowIso,
} from "./lifecycle";

export interface EvictResult {
  refreshed: string[]; // stale last_seen_at but label still receives mail
  archived: string[];
  deleted: string[];
  failed: string[];
  errors: string[];
}

export async function evictDomains(
  gmailEnv: GmailEnv,
  db: D1Database,
  cfg: LifecycleConfig,
): Promise<EvictResult> {
  const result: EvictResult = { refreshed: [], archived: [], deleted: [], failed: [], errors: [] };

  // Build label map to check if labels still exist before deleting.
  let labels: GmailLabel[];
  try {
    labels = await listLabels(gmailEnv);
  } catch (e) {
    result.errors.push(`listLabels: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const labelById = new Set(labels.map((l) => l.id));

  // Phase 1: active -> archived (delete label + filter, keep D1 row)
  const EVICT_BATCH = 10;
  const activeDomains = await getDomainsByState(db, "active");
  let examined = 0;
  for (const row of activeDomains) {
    if (examined >= EVICT_BATCH) break;
    const age = daysSince(row.last_seen_at);
    if (age < cfg.evictArchiveDays) continue;
    examined++;

    try {
      // The label may still be receiving mail via its filter; check before archiving.
      if (row.label_id && labelById.has(row.label_id)) {
        const recent = await listMessages(
          gmailEnv,
          `newer_than:${cfg.evictArchiveDays}d`,
          1,
          undefined,
          [row.label_id],
        );
        if ((recent.messages?.length ?? 0) > 0) {
          await touchDomainLastSeenStmt(db, row.domain, nowIso()).run();
          result.refreshed.push(row.domain);
          console.log(`[evict] kept ${row.domain} active (label has mail within ${cfg.evictArchiveDays}d)`);
          continue;
        }
      }

      // Delete the filter first (stop auto-labeling new mail).
      if (row.filter_id) {
        try {
          await deleteFilter(gmailEnv, row.filter_id);
        } catch (e) {
          // Filter might already be deleted — non-fatal.
          result.errors.push(`evict delete filter ${row.domain}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Delete the label entirely (removes it from Gmail sidebar + all messages).
      if (row.label_id && labelById.has(row.label_id)) {
        await deleteLabel(gmailEnv, row.label_id);
      }

      await updateDomainState(db, row.domain, "archived", {
        label_id: null,
        label_name: null,
        filter_id: null,
        archived_at: nowIso(),
      });

      result.archived.push(row.domain);
      console.log(`[evict] archived ${row.domain} (last seen ${age}d ago, label+filter deleted)`);
    } catch (e) {
      result.failed.push(row.domain);
      result.errors.push(`archive ${row.domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Phase 2: archived -> deleted (just delete D1 row, label already gone)
  // Deletion is based on archived_at (when the domain was archived), not
  // last_seen_at — the domain may have been archived during migration with
  // unknown last_seen_at.
  const archivedDomains = await getDomainsByState(db, "archived");
  let deletedCount = 0;
  for (const row of archivedDomains) {
    if (deletedCount >= EVICT_BATCH) break;
    const age = daysSince(row.archived_at);
    if (age < cfg.evictDeleteDays) continue;

    try {
      // Label was already deleted in Phase 1 — just clean up D1.
      await deleteDomain(db, row.domain);
      result.deleted.push(row.domain);
      deletedCount++;
      console.log(`[evict] deleted ${row.domain} (last seen ${age}d ago, D1 row removed)`);
    } catch (e) {
      result.failed.push(row.domain);
      result.errors.push(`delete ${row.domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
