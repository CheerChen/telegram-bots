// Promotion: untracked domain -> active label.
//
// For each promotion candidate:
//   1. Create or reuse the label "Domains/<domain>"
//   2. Create a filter: from:@<domain> -> addLabelIds=[labelId], removeLabelIds=["INBOX"]
//   3. Batch-apply the label to existing inbox messages from this domain (and archive them)
//   4. Update D1 state to "active"

import type { D1Database } from "@cloudflare/workers-types";
import {
  type GmailEnv,
  type GmailLabel,
  listLabels,
  createLabel,
  createFilter,
  listAllMessageIds,
  batchModify,
} from "./gmail";
import {
  type LifecycleConfig,
  activeLabelName,
  updateDomainState,
  nowIso,
} from "./lifecycle";

export interface PromoteResult {
  promoted: string[];
  failed: string[];
  deferred: string[]; // candidates left for the next run (per-run cap)
  errors: string[];
}

// Each promotion costs >= 4 subrequests (label, filter, list, batchModify).
// Cap per run so a cold start with many candidates stays inside the Free
// plan's 50 subrequests; candidates are recomputed from D1 every run, so the
// remainder is promoted on the following run.
const PROMOTE_BATCH = 5;

export async function promoteDomains(
  gmailEnv: GmailEnv,
  db: D1Database,
  cfg: LifecycleConfig,
  candidates: string[],
): Promise<PromoteResult> {
  const result: PromoteResult = {
    promoted: [],
    failed: [],
    deferred: candidates.slice(PROMOTE_BATCH),
    errors: [],
  };

  // Build label name -> label map once.
  let labels: GmailLabel[];
  try {
    labels = await listLabels(gmailEnv);
  } catch (e) {
    result.errors.push(`listLabels: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const labelMap = new Map(labels.map((l) => [l.name, l]));

  for (const domain of candidates.slice(0, PROMOTE_BATCH)) {
    try {
      const labelName = activeLabelName(cfg, domain);

      // Step 1: Create or reuse label.
      let label = labelMap.get(labelName);
      if (!label) {
        label = await createLabel(gmailEnv, labelName);
        labelMap.set(labelName, label);
        console.log(`[promote] created label: ${labelName} (${label.id})`);
      }

      // Step 2: Create filter (from:@domain -> label + archive).
      const filter = await createFilter(
        gmailEnv,
        { from: `@${domain}` },
        { addLabelIds: [label.id], removeLabelIds: ["INBOX"] },
      );
      console.log(`[promote] created filter: from:@${domain} -> ${labelName} (${filter.id})`);

      // Step 3: Apply label to ALL existing messages from this domain.
      // Search without in:inbox to catch already-archived mail too.
      // Only remove INBOX from messages that are actually in the inbox.
      const allMessageIds = await listAllMessageIds(
        gmailEnv,
        `from:@${domain}`,
        10000,
      );
      if (allMessageIds.length > 0) {
        // batchModify max 1000 per call. Add label to all messages.
        // Only remove INBOX (archive) — Gmail ignores removeLabelIds for
        // messages not in INBOX, so it's safe to always include it.
        for (let i = 0; i < allMessageIds.length; i += 1000) {
          const batch = allMessageIds.slice(i, i + 1000);
          await batchModify(gmailEnv, batch, [label.id], ["INBOX"]);
        }
        console.log(`[promote] labeled + archived ${allMessageIds.length} messages for ${domain}`);
      }

      // Step 4: Update D1 state.
      await updateDomainState(db, domain, "active", {
        label_id: label.id,
        label_name: labelName,
        filter_id: filter.id,
        promoted_at: nowIso(),
      });

      result.promoted.push(domain);
    } catch (e) {
      result.failed.push(domain);
      result.errors.push(`promote ${domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
