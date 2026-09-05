-- Gmail label lifecycle state machine.
--
-- One row per tracked domain. The state column drives the lifecycle:
--   untracked  — domain seen in inbox but not yet promoted (below threshold)
--   active     — has a Domains/<domain> label + filter, new mail auto-labeled
--   archived   — moved to Domains/_archive/<domain>, filter deleted
--
-- Transitions:
--   untracked -> active    (promotion: window count >= threshold)
--   active    -> archived  (no new mail for EVICT_ARCHIVE_DAYS)
--   archived  -> active    (wake: new mail from this domain)
--   archived  -> deleted   (no new mail for EVICT_DELETE_DAYS; row removed)
--   active    -> deleted   (manual cleanup during migration)

CREATE TABLE IF NOT EXISTS domains (
  domain          TEXT PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT 'untracked'
                  CHECK (state IN ('untracked', 'active', 'archived')),
  label_id        TEXT,              -- Gmail label ID (null when untracked)
  label_name      TEXT,              -- e.g. "Domains/github.com" or "Domains/_archive/github.com"
  filter_id       TEXT,              -- Gmail filter ID (null when archived or untracked)
  total_count     INTEGER NOT NULL DEFAULT 0,
  last_seen_at    TEXT,              -- last time mail from this domain was confirmed
                                     -- (inbox scan for untracked/archived; label check in evict for active)
  first_seen_at   TEXT,              -- ISO date of first email from this domain
  promoted_at     TEXT,              -- when untracked -> active happened
  archived_at     TEXT,              -- when active -> archived happened
  updated_at      TEXT NOT NULL,     -- last time this row was touched
  UNIQUE (domain)
);

CREATE INDEX IF NOT EXISTS idx_domains_state ON domains (state);
CREATE INDEX IF NOT EXISTS idx_domains_last_seen ON domains (last_seen_at);

-- Rolling window count for promotion. One row per (domain, date).
-- Pruned to PROMOTE_WINDOW_DAYS on each scan run.
CREATE TABLE IF NOT EXISTS domain_daily_counts (
  domain          TEXT NOT NULL,
  date            TEXT NOT NULL,     -- YYYY-MM-DD
  count           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, date),
  FOREIGN KEY (domain) REFERENCES domains (domain) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ddc_date ON domain_daily_counts (date);

-- Message IDs already counted by the scanner. Prevents double counting when
-- overlapping scan windows (newer_than:2d daily, or a wide cold-start scan)
-- see the same message again. Rows are pruned by message_date once older than
-- the promotion window, after which no scan query can return the message.
CREATE TABLE IF NOT EXISTS scanned_messages (
  id            TEXT PRIMARY KEY,  -- Gmail message ID
  message_date  TEXT NOT NULL      -- YYYY-MM-DD derived from internalDate
);

CREATE INDEX IF NOT EXISTS idx_scanned_messages_date ON scanned_messages (message_date);
