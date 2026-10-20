// The /wx/ home page lists every ready pack from one KV key, so a page view is
// one read instead of a KV list (free plan: 1,000 lists/day).
export interface CatalogEntry {
  id: string;
  title: string;
  animated: boolean;
  count: number;
  readyAt: number;
}

// Replaces the pack's entry (a re-import keeps one row) and keeps newest first.
export function upsertEntry(catalog: CatalogEntry[], entry: CatalogEntry): CatalogEntry[] {
  return [entry, ...catalog.filter((e) => e.id !== entry.id)].sort((a, b) => b.readyAt - a.readyAt);
}
