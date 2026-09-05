// Sync: reconcile D1 state with Gmail.
//
// After migration, D1 may say "archived" but Gmail still has the label and
// filter. This module brings Gmail into alignment with D1:
//
//   - archived domains: delete label + delete filter in Gmail
//     (D1 keeps the row for wake detection; label_id is nulled)
//   - active domains with missing labels: no action (handled by promote/wake)
//
// Runs in batches to stay within the subrequest limit.

import type { D1Database } from "@cloudflare/workers-types";
import {
  type GmailEnv,
  type GmailLabel,
  listLabels,
  deleteLabel,
  deleteFilter,
} from "./gmail";
import {
  type LifecycleConfig,
  type DomainRow,
  getDomainsByState,
  activeLabelName,
  updateDomainState,
  nowIso,
} from "./lifecycle";

export interface SyncResult {
  archivedInGmail: string[];   // label + filter deleted in Gmail
  skipped: string[];
  failed: string[];
  errors: string[];
  nextOffset: number | null;
}

export async function syncToGmail(
  gmailEnv: GmailEnv,
  db: D1Database,
  cfg: LifecycleConfig,
  offset = 0,
  limit = 20,
): Promise<SyncResult> {
  const result: SyncResult = {
    archivedInGmail: [],
    skipped: [],
    failed: [],
    errors: [],
    nextOffset: null,
  };

  // Fetch all labels (1 subrequest).
  let labels: GmailLabel[];
  try {
    labels = await listLabels(gmailEnv);
  } catch (e) {
    result.errors.push(`listLabels: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const labelById = new Set(labels.map((l) => l.id));

  // Collect archived domains that still have a label or filter in Gmail.
  const archivedDomains = await getDomainsByState(db, "archived");

  type SyncItem = {
    domain: string;
    row: DomainRow;
  };

  const items: SyncItem[] = [];

  for (const row of archivedDomains) {
    // Needs cleanup if label still exists in Gmail or filter_id is set.
    const labelExists = row.label_id && labelById.has(row.label_id);
    const filterExists = !!row.filter_id;
    if (labelExists || filterExists) {
      items.push({ domain: row.domain, row });
    } else {
      result.skipped.push(row.domain);
    }
  }

  // Slice the batch.
  const batch = items.slice(offset, offset + limit);
  result.nextOffset = offset + limit < items.length ? offset + limit : null;

  for (const item of batch) {
    const { domain, row } = item;
    try {
      // Delete the filter if it still exists.
      if (row.filter_id) {
        try {
          await deleteFilter(gmailEnv, row.filter_id);
        } catch (e) {
          // Filter might already be deleted — non-fatal.
          result.errors.push(`sync delete filter ${domain}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Delete the label entirely (removes from Gmail sidebar + all messages).
      if (row.label_id && labelById.has(row.label_id)) {
        await deleteLabel(gmailEnv, row.label_id);
      }

      // Null out label_id, label_name, filter_id in D1.
      await updateDomainState(db, domain, "archived", {
        label_id: null,
        label_name: null,
        filter_id: null,
        archived_at: row.archived_at ?? nowIso(),
      });

      result.archivedInGmail.push(domain);
      console.log(`[sync] deleted label+filter for ${domain}`);
    } catch (e) {
      result.failed.push(domain);
      result.errors.push(`sync ${domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
