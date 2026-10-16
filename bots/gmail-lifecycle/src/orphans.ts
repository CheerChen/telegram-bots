// Orphan filter check.
//
// Deleting a label in Gmail strips it from the filters that applied it but
// keeps their other actions, so a filter that labelled + archived becomes one
// that only skips the inbox: matching mail lands in All Mail with no label
// and is effectively invisible. This happens when a label is removed by hand
// in the Gmail UI (the worker itself deletes the filter before the label).
// The daily cycle reports such filters; removing them is left to the user.

import { type GmailEnv, listFilters, listLabels } from "./gmail";

/** Criteria of filters that skip the inbox but add no existing label. */
export async function findOrphanFilters(gmailEnv: GmailEnv): Promise<string[]> {
  const [labels, filters] = await Promise.all([listLabels(gmailEnv), listFilters(gmailEnv)]);
  const labelIds = new Set(labels.map((l) => l.id));
  return filters
    .filter((f) => {
      const action = f.action ?? {};
      if (!action.removeLabelIds?.includes("INBOX")) return false;
      return !(action.addLabelIds ?? []).some((id) => labelIds.has(id));
    })
    .map((f) => f.criteria?.from ?? f.criteria?.query ?? JSON.stringify(f.criteria ?? {}));
}
