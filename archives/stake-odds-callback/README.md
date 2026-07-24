# stake-odds-callback

Cloudflare Worker that owns Telegram `callback_query` events for the
stake-odds inline keyboard buttons. Replaces the `getUpdates` long-polling
loop that used to run on the Pi.

## Why a Worker

The Pi sits behind a home NAT, so it can't receive a Telegram webhook
directly and instead long-polled `getUpdates`. That loop was the source of
every "button click is flaky" symptom:

- **409 Conflict** whenever a second consumer touched the same bot token
  (e.g. `pnpm dev` running locally on the Mac during a redeploy).
- **long-connection drops** (`polling error: fetch failed`) on Pi network
  blips — clicks during the outage were never processed.
- **offset not persisted**, so every container restart replayed the last
  24h of clicks, firing stale playful messages with no user action.
- **ack / reply split across two API calls**, so a sendMessage failure
  left the spinner stopped but no message — the canonical "点了没反应".

The Worker is stateless and reached at a public HTTPS URL, so none of the
above apply: no long connection, no offset, no 409 (webhook and getUpdates
are mutually exclusive), ack + reply happen in one request, and Telegram
itself handles webhook retries.

## Architecture

```
user taps button
   │
   ▼
Telegram ──webhook push──▶ CF Worker (stateless)
                            ├─ verify X-Telegram-Bot-Api-Secret-Token
                            ├─ answerCallbackQuery  (stop spinner)
                            └─ sendMessage reply_to=cq.message.message_id
                                  (persistent playful message in the topic)

Pi stake-odds (getUpdates removed)        Stake GraphQL (cf_clearance)
   ├─ seed / edit / delete board messages
   └─ odds-change notifications
```

All reply targets (`chat_id`, `message_thread_id`, `message_id`) come from
the update payload — the Worker needs no state sync with the Pi. The Pi
keeps owning the board and the Stake fetch; it just no longer polls.

## Deploy

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in TELEGRAM_BOT_TOKEN + STAKE_CALLBACK_SECRET
pnpm secrets:push                # upload secrets to the Worker
pnpm deploy                      # publishes to Cloudflare
```

Note the Worker URL printed by `wrangler deploy`, e.g.
`https://stake-odds-callback.<account>.workers.dev`.

## Migration (avoid 409)

Order matters: setting a webhook disables `getUpdates`, but only after
the next `getUpdates` call returns 409. To avoid a brief conflict window,
do this exact sequence:

1. **First**, set the webhook (replaces `.dev.vars` value for the secret):

   ```bash
   TOKEN=...                 # same bot token the Pi uses
   SECRET=...                # the STAKE_CALLBACK_SECRET you uploaded
   URL=https://stake-odds-callback.<account>.workers.dev
   curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
        -d "url=${URL}" -d "secret_token=${SECRET}" -d "allowed_updates=%5B%22callback_query%22%5D"
   ```

   `allowed_updates=["callback_query"]` ensures the Worker only receives
   callbacks — plain chat messages stay un-routed (the Pi doesn't need
   them either; it never used them).

2. **Then**, rebuild + redeploy the Pi service with the poller removed
   (`make release-sha`). Until step 1 is done,
   do NOT redeploy the Pi alone — that would create a window where
   neither the old poller nor the webhook is active.

3. Verify: tap a board button → spinner stops within ~1s and a playful
   reply appears in the topic.

## Rollback

```bash
curl -s "https://api.telegram.org/bot${TOKEN}/deleteWebhook"
```

Then redeploy the Pi from a commit that still contains `polling.ts`.
