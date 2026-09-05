# gmail-lifecycle

Daily Gmail label lifecycle manager. Runs as a Cloudflare Worker with a D1
database for state. Automatically promotes, archives, wakes, and deletes
domain-based labels so your label tree stays clean without manual maintenance.

## Lifecycle

```
收件箱 (unclassified)
      |
      | 90 days >= 5 emails
      v
  Domains/<domain>           active: filter auto-labels + archives new mail
      |
      | 180 days no new mail
      v
  Domains/_archive/<domain>  archived: filter deleted, label hidden
      |
      | 365 days no new mail
      v
  deleted                    label + D1 row removed
      |
      | new mail while archived
      v
  Domains/<domain>           woken: label restored + filter recreated
```

## Setup

### 1. Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/) > APIs &
   Services > enable **Gmail API**
2. Credentials > Create OAuth 2.0 Client ID (type: **Desktop app**)
3. Download the JSON, save as `scripts/credentials.json`

### 2. Get refresh token (one-time, local)

```bash
cd bots/gmail-lifecycle
uv run scripts/get_refresh_token.py --credentials scripts/credentials.json
```

This opens a browser, you authorize, and it prints the refresh token +
client ID + client secret.

### 3. Create D1 database + KV namespace

```bash
wrangler d1 create gmail-lifecycle
# Copy the database_id into wrangler.toml

wrangler kv namespace create GMAIL_STATE
# Copy the id into wrangler.toml
```

### 4. Apply schema

```bash
pnpm db:apply:local    # local dev
pnpm db:apply          # remote
```

### 5. Set secrets

Create `.dev.vars`:

```
GMAIL_CLIENT_ID=<from step 2>
GMAIL_CLIENT_SECRET=<from step 2>
GMAIL_REFRESH_TOKEN=<from step 2>
ADMIN_SECRET=<random string>
```

```bash
pnpm secrets:push
```

### 6. Deploy

```bash
pnpm deploy
```

Or just push to master — the `deploy-workers.yml` workflow deploys all
`bots/*` automatically.

## First run: migrate existing labels

If you have existing `Domains/*` labels from the old Python scripts, run
the one-time migration to import them into D1:

```bash
curl -X POST https://gmail-lifecycle.<account>.workers.dev/migrate \
  -H "x-admin-secret: <ADMIN_SECRET>"
```

This imports all existing `Domains/*` labels, links their filters, and
classifies them as active or archived based on recent message activity.
After migration, the daily cron takes over maintenance.

## Cold start: promote from the current window

To reach the target state immediately instead of waiting for daily scans to
accumulate 90 days of counts, scan the whole promotion window once. Scans are
deduplicated by message ID, so this is safe to repeat and does not double
count against the daily cron.

```bash
curl -X POST 'https://gmail-lifecycle.<account>.workers.dev/run?window=90d&max=500' \
  -H "x-admin-secret: <ADMIN_SECRET>"
```

If the response has a non-null `scan.nextPageToken`, call again with
`&pageToken=<token>` until it is null. Promotion candidates are computed from
D1 over the whole window, so domains split across pages are still promoted.

## Manual routes

| Method | Path       | Description                                         |
|--------|------------|-----------------------------------------------------|
| GET    | `/`        | Worker info + config                                |
| GET    | `/status`  | D1 state summary (domain counts)                    |
| POST   | `/run`     | Run the full cycle. Params: `window`, `max`, `pageToken` |
| POST   | `/migrate` | One-time import of existing labels (`offset`, `limit`) |
| POST   | `/sync`    | Reconcile D1 with Gmail (`offset`, `limit`)         |

All routes except `/` require `x-admin-secret` header.

## Subrequest budget (Free plan: 50 per invocation)

From headers are fetched through the Gmail batch endpoint, 50 messages per
HTTP request, so one invocation can scan several hundred messages. D1 writes
for a whole scan are committed with `db.batch()`. With `SCAN_MAX_MESSAGES=500`
a scan costs roughly 5 list calls + 10 batch calls plus a handful of D1 calls.

## Configuration

All thresholds are configurable via `[vars]` in `wrangler.toml`:

| Var                  | Default | Description                          |
|----------------------|---------|--------------------------------------|
| LABEL_PREFIX         | Domains | Active label namespace               |
| ARCHIVE_PREFIX       | Domains/_archive | Archive label namespace     |
| PROMOTE_WINDOW_DAYS  | 90      | Rolling window for promotion count   |
| PROMOTE_MIN_EMAILS   | 5       | Min emails in window to promote      |
| EVICT_ARCHIVE_DAYS   | 180     | Days without mail -> archive         |
| EVICT_DELETE_DAYS    | 365     | Days without mail -> delete          |
| SCAN_MAX_MESSAGES    | 500     | Message IDs listed per run           |
