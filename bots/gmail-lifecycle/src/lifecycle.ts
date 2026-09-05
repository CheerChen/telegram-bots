// Lifecycle state machine: D1 queries and domain normalization.
//
// The state column drives transitions:
//   untracked -> active    promotion (scan.ts detects threshold met)
//   active    -> archived  eviction (evict.ts: no new mail for EVICT_ARCHIVE_DAYS)
//   archived  -> active    wake (scan.ts detects new mail from archived domain)
//   archived  -> deleted   eviction (evict.ts: no new mail for EVICT_DELETE_DAYS)

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export type DomainState = "untracked" | "active" | "archived";

export interface DomainRow {
  domain: string;
  state: DomainState;
  label_id: string | null;
  label_name: string | null;
  filter_id: string | null;
  total_count: number;
  last_seen_at: string | null;
  first_seen_at: string | null;
  promoted_at: string | null;
  archived_at: string | null;
  updated_at: string;
}

export interface LifecycleConfig {
  labelPrefix: string;          // "Domains"
  archivePrefix: string;        // "Domains/_archive"
  promoteWindowDays: number;    // 30
  promoteMinEmails: number;     // 15
  evictArchiveDays: number;     // 180
  evictDeleteDays: number;      // 365
  scanMaxMessages: number;      // 500 (message IDs listed per run)
}

export function parseConfig(vars: Record<string, string>): LifecycleConfig {
  return {
    labelPrefix: vars.LABEL_PREFIX ?? "Domains",
    archivePrefix: vars.ARCHIVE_PREFIX ?? "Domains/_archive",
    promoteWindowDays: parseInt(vars.PROMOTE_WINDOW_DAYS ?? "30", 10),
    promoteMinEmails: parseInt(vars.PROMOTE_MIN_EMAILS ?? "15", 10),
    evictArchiveDays: parseInt(vars.EVICT_ARCHIVE_DAYS ?? "180", 10),
    evictDeleteDays: parseInt(vars.EVICT_DELETE_DAYS ?? "365", 10),
    scanMaxMessages: parseInt(vars.SCAN_MAX_MESSAGES ?? "500", 10),
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysSince(isoDate: string | null): number {
  if (!isoDate) return Infinity;
  const then = new Date(isoDate).getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Domain normalization
// ---------------------------------------------------------------------------

// Common two-part TLDs that tldextract-style logic must handle.
// For simplicity in a Worker (no tldextract), we use a curated suffix list.
const MULTI_PART_TLDS = new Set([
  "co.jp", "co.uk", "co.kr", "com.cn", "com.au", "com.br", "com.tw",
  "com.hk", "com.sg", "com.my", "com.ph", "com.vn", "com.ar", "com.mx",
  "co.nz", "co.in", "co.za", "ne.jp", "or.jp", "ac.jp", "go.jp", "ed.jp",
  "org.uk", "ac.uk", "gov.uk", "net.au", "org.au", "net.cn", "org.cn",
  "gov.cn", "edu.cn", "net.nz", "org.nz", "co.th", "in.th",
]);

/**
 * Normalize a sender domain to its registered/root domain.
 * Worker-safe (no tldextract dependency). Handles common multi-part TLDs.
 *
 * Examples:
 *   mail.github.com      -> github.com
 *   shipment.amazon.co.jp -> amazon.co.jp
 *   noreply.example.com   -> example.com
 *   sub.example.co.uk     -> example.co.uk
 */
export function normalizeDomain(rawDomain: string): string {
  const parts = rawDomain.toLowerCase().split(".");
  if (parts.length <= 2) return rawDomain.toLowerCase();

  // Check if the last two parts form a known multi-part TLD.
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) {
    // Root = last three parts (e.g. amazon.co.jp from shipment.amazon.co.jp)
    if (parts.length >= 3) return parts.slice(-3).join(".");
    return lastTwo;
  }
  // Root = last two parts
  return parts.slice(-2).join(".");
}

// ---------------------------------------------------------------------------
// D1 queries
// ---------------------------------------------------------------------------

export async function getDomain(db: D1Database, domain: string): Promise<DomainRow | null> {
  const row = await db.prepare("SELECT * FROM domains WHERE domain = ?").bind(domain).first<DomainRow>();
  return row ?? null;
}

// D1 allows at most 100 bound parameters per statement.
const IN_CHUNK = 90;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Fetch many domain rows at once. Missing domains are simply absent from the map. */
export async function getDomains(db: D1Database, domains: string[]): Promise<Map<string, DomainRow>> {
  const out = new Map<string, DomainRow>();
  for (const chunk of chunked(domains, IN_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db
      .prepare(`SELECT * FROM domains WHERE domain IN (${placeholders})`)
      .bind(...chunk)
      .all<DomainRow>();
    for (const r of rows.results ?? []) out.set(r.domain, r);
  }
  return out;
}

// Scan writes are returned as prepared statements so scan.ts can commit a whole
// run through db.batch() instead of one round trip per message.

/** Insert an untracked domain or add `count` new messages to an existing row. */
export function upsertUntrackedDomainStmt(
  db: D1Database,
  domain: string,
  lastSeenIso: string,
  count: number,
): D1PreparedStatement {
  const ts = nowIso();
  // last_seen_at only moves forward; MAX() returns NULL if either side is NULL.
  return db
    .prepare(
      `INSERT INTO domains (domain, state, total_count, last_seen_at, first_seen_at, updated_at)
       VALUES (?1, 'untracked', ?2, ?3, ?3, ?4)
       ON CONFLICT(domain) DO UPDATE SET
         total_count = total_count + ?2,
         last_seen_at = COALESCE(MAX(last_seen_at, ?3), ?3),
         updated_at = ?4`,
    )
    .bind(domain, count, lastSeenIso, ts);
}

/** Add `count` messages to the (domain, date) bucket. */
export function incrementDailyCountStmt(
  db: D1Database,
  domain: string,
  dateStr: string,
  count: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO domain_daily_counts (domain, date, count)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(domain, date) DO UPDATE SET count = count + ?3`,
    )
    .bind(domain, dateStr, count);
}

/**
 * Untracked domains whose message count inside the promotion window meets the
 * threshold. Reads D1 only, so it is independent of which messages the current
 * scan happened to see: a paged cold-start scan or a failed promotion is
 * picked up on the next run automatically.
 */
export async function getPromotionCandidates(
  db: D1Database,
  windowDays: number,
  minEmails: number,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .prepare(
      `SELECT c.domain AS domain FROM domain_daily_counts c
       JOIN domains d ON d.domain = c.domain
       WHERE d.state = 'untracked' AND c.date >= ?
       GROUP BY c.domain HAVING SUM(c.count) >= ?
       ORDER BY SUM(c.count) DESC`,
    )
    .bind(cutoff, minEmails)
    .all<{ domain: string }>();
  return (rows.results ?? []).map((r) => r.domain);
}

export async function pruneDailyCounts(db: D1Database, windowDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await db.prepare("DELETE FROM domain_daily_counts WHERE date < ?").bind(cutoff).run();
}

export async function getDomainsByState(db: D1Database, state: DomainState): Promise<DomainRow[]> {
  const results = await db
    .prepare("SELECT * FROM domains WHERE state = ? ORDER BY last_seen_at DESC")
    .bind(state)
    .all<DomainRow>();
  return results.results ?? [];
}

export async function getAllDomains(db: D1Database): Promise<DomainRow[]> {
  const results = await db.prepare("SELECT * FROM domains ORDER BY last_seen_at DESC").all<DomainRow>();
  return results.results ?? [];
}

export async function updateDomainState(
  db: D1Database,
  domain: string,
  state: DomainState,
  fields: Partial<Pick<DomainRow, "label_id" | "label_name" | "filter_id" | "last_seen_at" | "promoted_at" | "archived_at">> = {},
): Promise<void> {
  const ts = nowIso();
  const sets: string[] = ["state = ?", "updated_at = ?"];
  const binds: (string | number | null)[] = [state, ts];

  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    binds.push(value);
  }
  binds.push(domain);
  await db.prepare(`UPDATE domains SET ${sets.join(", ")} WHERE domain = ?`).bind(...binds).run();
}

export async function deleteDomain(db: D1Database, domain: string): Promise<void> {
  await db.prepare("DELETE FROM domains WHERE domain = ?").bind(domain).run();
}

/** Move last_seen_at forward to `lastSeenIso` if it is newer than the stored value. */
export function touchDomainLastSeenStmt(
  db: D1Database,
  domain: string,
  lastSeenIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE domains SET last_seen_at = COALESCE(MAX(last_seen_at, ?1), ?1), updated_at = ?2
       WHERE domain = ?3`,
    )
    .bind(lastSeenIso, nowIso(), domain);
}

// ---------------------------------------------------------------------------
// Scanned-message dedup
// ---------------------------------------------------------------------------

/** Return the subset of `ids` that has not been counted by a previous scan. */
export async function filterUnscannedIds(db: D1Database, ids: string[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const chunk of chunked(ids, IN_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db
      .prepare(`SELECT id FROM scanned_messages WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of rows.results ?? []) seen.add(r.id);
  }
  return ids.filter((id) => !seen.has(id));
}

export function markMessageScannedStmt(
  db: D1Database,
  id: string,
  messageDate: string,
): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO scanned_messages (id, message_date) VALUES (?, ?)")
    .bind(id, messageDate);
}

/** Drop dedup rows older than the promotion window (plus slack for newer_than: rounding). */
export async function pruneScannedMessages(db: D1Database, windowDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - (windowDays + 2) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await db.prepare("DELETE FROM scanned_messages WHERE message_date < ?").bind(cutoff).run();
}

// ---------------------------------------------------------------------------
// Label naming helpers
// ---------------------------------------------------------------------------

export function activeLabelName(cfg: LifecycleConfig, domain: string): string {
  return `${cfg.labelPrefix}/${domain}`;
}

export function archiveLabelName(cfg: LifecycleConfig, domain: string): string {
  return `${cfg.archivePrefix}/${domain}`;
}

/** Check if a label name is an active domain label (e.g. "Domains/github.com"). */
export function parseActiveLabelName(
  cfg: LifecycleConfig,
  name: string,
): string | null {
  const prefix = `${cfg.labelPrefix}/`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (rest.startsWith("_")) return null; // archive or other special
  return rest;
}

/** Check if a label name is an archived domain label (e.g. "Domains/_archive/github.com"). */
export function parseArchiveLabelName(
  cfg: LifecycleConfig,
  name: string,
): string | null {
  const prefix = `${cfg.archivePrefix}/`;
  if (!name.startsWith(prefix)) return null;
  return name.slice(prefix.length);
}
