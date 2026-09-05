// Wake: archived domain -> active.
//
// When an archived domain receives new mail, recreate its label and filter:
//   1. Create label "Domains/<domain>" (it was deleted during archiving)
//   2. Create filter: from:@<domain> -> addLabelIds=[labelId], removeLabelIds=["INBOX"]
//   3. Label + archive the new messages that triggered the wake
//   4. Update D1 state to "active"

import type { D1Database } from "@cloudflare/workers-types";
import {
  type GmailEnv,
  type GmailLabel,
  listLabels,
  createFilter,
  createLabel,
  listAllMessageIds,
  batchModify,
} from "./gmail";
import {
  type LifecycleConfig,
  activeLabelName,
  updateDomainState,
  getDomain,
  nowIso,
} from "./lifecycle";

export interface WakeResult {
  woken: string[];
  failed: string[];
  errors: string[];
}

export async function wakeDomains(
  gmailEnv: GmailEnv,
  db: D1Database,
  cfg: LifecycleConfig,
  candidates: string[],
): Promise<WakeResult> {
  const result: WakeResult = { woken: [], failed: [], errors: [] };

  if (!candidates.length) return result;

  // Build label map to check for existing labels.
  let labels: GmailLabel[];
  try {
    labels = await listLabels(gmailEnv);
  } catch (e) {
    result.errors.push(`listLabels: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const labelByName = new Map(labels.map((l) => [l.name, l]));

  for (const domain of candidates) {
    try {
      const row = await getDomain(db, domain);
      if (!row || row.state !== "archived") continue;

      const activeName = activeLabelName(cfg, domain);

      // Step 1: Create label (or reuse if it somehow exists).
      let labelId: string;
      const existing = labelByName.get(activeName);
      if (existing) {
        labelId = existing.id;
      } else {
        const newLabel = await createLabel(gmailEnv, activeName);
        labelId = newLabel.id;
        console.log(`[wake] created label: ${activeName} (${labelId})`);
      }

      // Step 2: Create filter.
      const filter = await createFilter(
        gmailEnv,
        { from: `@${domain}` },
        { addLabelIds: [labelId], removeLabelIds: ["INBOX"] },
      );
      console.log(`[wake] created filter: from:@${domain} -> ${activeName} (${filter.id})`);

      // Step 3: Label + archive ALL messages from this domain.
      const messageIds = await listAllMessageIds(
        gmailEnv,
        `from:@${domain}`,
        10000,
      );
      if (messageIds.length > 0) {
        for (let i = 0; i < messageIds.length; i += 1000) {
          const batch = messageIds.slice(i, i + 1000);
          await batchModify(gmailEnv, batch, [labelId], ["INBOX"]);
        }
        console.log(`[wake] labeled + archived ${messageIds.length} messages for ${domain}`);
      }

      // Step 4: Update D1 state.
      await updateDomainState(db, domain, "active", {
        label_id: labelId,
        label_name: activeName,
        filter_id: filter.id,
        archived_at: null,
      });

      result.woken.push(domain);
    } catch (e) {
      result.failed.push(domain);
      result.errors.push(`wake ${domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
