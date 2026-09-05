// One-time migration: import existing Domains/* labels into D1.
//
// Triggered manually via POST /migrate?offset=N&limit=M. Processes labels in
// batches to stay within the Worker subrequest limit (50 on Free plan).
//
// For each Domains/* label:
//   1. Query Gmail: does this label have messages in the last EVICT_ARCHIVE_DAYS?
//   2. If yes -> import as "active" with last_seen_at = now
//   3. If no  -> import as "archived" with last_seen_at = null (will be deleted
//      after EVICT_DELETE_DAYS by the daily cron)
//
// Labels already under Domains/_archive/ are always imported as "archived".
// Also finds and links existing filters (from:@domain -> label).

import type { D1Database } from "@cloudflare/workers-types";
import {
  type GmailEnv,
  type GmailLabel,
  type GmailFilter,
  type GmailMessageList,
  listLabels,
  listFilters,
  listMessages,
} from "./gmail";
import {
  type LifecycleConfig,
  type DomainState,
  parseActiveLabelName,
  parseArchiveLabelName,
  activeLabelName,
  archiveLabelName,
  getDomain,
  updateDomainState,
  nowIso,
} from "./lifecycle";

export interface MigrateResult {
  imported: number;
  activeImported: string[];
  archivedImported: string[];
  skipped: string[];
  errors: string[];
  nextOffset: number | null; // null when all labels processed
  totalLabels: number;
}

export async function migrateExistingLabels(
  gmailEnv: GmailEnv,
  db: D1Database,
  cfg: LifecycleConfig,
  offset = 0,
  limit = 40,
): Promise<MigrateResult> {
  const result: MigrateResult = {
    imported: 0,
    activeImported: [],
    archivedImported: [],
    skipped: [],
    errors: [],
    nextOffset: null,
    totalLabels: 0,
  };

  // Fetch all labels and filters (2 subrequests).
  let labels: GmailLabel[];
  let filters: GmailFilter[];
  try {
    [labels, filters] = await Promise.all([listLabels(gmailEnv), listFilters(gmailEnv)]);
  } catch (e) {
    result.errors.push(`fetch labels/filters: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Build filter map: from:@domain -> { filterId, labelId }
  const filterByDomain = new Map<string, { filterId: string; labelId: string }>();
  for (const f of filters) {
    const fromVal = (f.criteria?.from ?? "").trim().toLowerCase();
    if (fromVal.startsWith("@") && f.action?.addLabelIds?.length) {
      const domain = fromVal.slice(1);
      const labelId = f.action.addLabelIds[0];
      if (!labelId) continue;
      filterByDomain.set(domain, { filterId: f.id, labelId });
    }
  }

  // Filter to only Domains/* labels.
  const domainLabels = labels.filter((l) => {
    return parseActiveLabelName(cfg, l.name) !== null || parseArchiveLabelName(cfg, l.name) !== null;
  });
  result.totalLabels = domainLabels.length;

  // Slice the batch.
  const batch = domainLabels.slice(offset, offset + limit);
  result.nextOffset = offset + limit < domainLabels.length ? offset + limit : null;

  for (const label of batch) {
    const activeDomain = parseActiveLabelName(cfg, label.name);
    const archiveDomain = parseArchiveLabelName(cfg, label.name);
    const domain = activeDomain ?? archiveDomain;
    if (!domain) continue;

    const isArchive = archiveDomain !== null;

    try {
      // Check if domain already exists in D1 and is already migrated.
      const existing = await getDomain(db, domain);
      if (existing && existing.state !== "untracked") {
        result.skipped.push(domain);
        continue;
      }

      // Find matching filter.
      const filterInfo = filterByDomain.get(domain);
      const filterId = filterInfo?.filterId ?? null;

      // Determine state by checking message recency (1 subrequest per label).
      // Query: does this label have any messages in the last EVICT_ARCHIVE_DAYS?
      let state: DomainState;
      let labelName: string;
      let lastSeenIso: string | null;

      if (isArchive) {
        // Already under Domains/_archive/ — always archived.
        state = "archived";
        labelName = archiveLabelName(cfg, domain);
        lastSeenIso = null;
      } else {
        // Check if there's recent mail (1 subrequest).
        let hasRecent = false;
        try {
          const recent = await listMessages(
            gmailEnv,
            `label:${label.name} newer_than:${cfg.evictArchiveDays}d`,
            1,
          );
          hasRecent = (recent.messages?.length ?? 0) > 0;
        } catch (e) {
          result.errors.push(
            `check recency ${domain}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        if (hasRecent) {
          state = "active";
          labelName = activeLabelName(cfg, domain);
          lastSeenIso = nowIso();
        } else {
          // No recent mail — archive immediately.
          state = "archived";
          labelName = archiveLabelName(cfg, domain);
          lastSeenIso = null;
        }
      }

      // Insert or update D1 row.
      if (existing) {
        await updateDomainState(db, domain, state, {
          label_id: label.id,
          label_name: labelName,
          filter_id: filterId,
          promoted_at: state === "active" ? nowIso() : null,
          archived_at: state === "archived" ? nowIso() : null,
          last_seen_at: lastSeenIso,
        });
      } else {
        const ts = nowIso();
        await db
          .prepare(
            `INSERT INTO domains (domain, state, label_id, label_name, filter_id, total_count, last_seen_at, first_seen_at, promoted_at, archived_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            domain, state, label.id, labelName, filterId, 0,
            lastSeenIso, lastSeenIso,
            state === "active" ? ts : null,
            state === "archived" ? ts : null,
            ts,
          )
          .run();
      }

      result.imported++;
      if (state === "active") result.activeImported.push(domain);
      else result.archivedImported.push(domain);
    } catch (e) {
      result.errors.push(`migrate ${domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
