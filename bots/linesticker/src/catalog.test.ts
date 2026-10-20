import assert from "node:assert/strict";
import test from "node:test";

import { type CatalogEntry, upsertEntry } from "./catalog.ts";

const entry = (id: string, readyAt: number, title = id): CatalogEntry =>
  ({ id, title, animated: false, count: 1, readyAt });

test("upsertEntry keeps newest first", () => {
  const out = upsertEntry([entry("a", 1), entry("b", 3)], entry("c", 2));
  assert.deepEqual(out.map((e) => e.id), ["b", "c", "a"]);
});

test("upsertEntry replaces a re-imported pack instead of duplicating it", () => {
  const out = upsertEntry([entry("a", 1, "old"), entry("b", 2)], entry("a", 5, "new"));
  assert.deepEqual(out.map((e) => [e.id, e.title]), [["a", "new"], ["b", "b"]]);
});
