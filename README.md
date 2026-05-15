# telegram-bots

Monorepo for personal Telegram bots deployed on Cloudflare Workers.

## Structure

```
packages/shared/    # Telegram client, webhook auth, shared types
bots/katakana/      # CN/EN word -> Japanese / Katakana (Jisho API)
bots/ctxd/          # Slack link -> summarize / translate / draft reply
```

Each bot under `bots/` is an independent Cloudflare Worker with its own
`wrangler.toml`, secrets, and KV bindings. Shared code lives in
`packages/shared` and is consumed via pnpm workspace protocol.

## Prereqs

- Node 20+
- pnpm 11+
- A Cloudflare account, `wrangler login` once

## Install

```bash
pnpm install
```

`wrangler` is a dev dependency of each bot — no global install needed.

## Per-bot setup: katakana

### Telegram

1. `@BotFather` → `/newbot` → save token
2. Send the bot any message, then:
   ```bash
   curl 'https://api.telegram.org/bot<TOKEN>/getUpdates' | jq '.result[].message.chat.id'
   ```
   Save your chat id.
3. Generate a random webhook secret:
   ```bash
   openssl rand -hex 32
   ```

### Cloudflare

```bash
cd bots/katakana

# Secrets (encrypted, not in git)
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Vars (non-secret, edit wrangler.toml directly)
# ALLOWED_CHAT_ID = "<your chat id>"

# Deploy
pnpm deploy
```

After first deploy, register the webhook:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  --data-urlencode "url=https://katakana-bot.<your-subdomain>.workers.dev/webhook" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

## Local dev

```bash
cd bots/katakana
cp .dev.vars.example .dev.vars   # fill in real values
pnpm dev                          # wrangler dev with hot reload
```

Local dev does not receive Telegram webhooks unless you tunnel
(e.g. `cloudflared tunnel`). For most iteration just `pnpm deploy` and
test against the live worker.

## Per-bot setup: ctxd

`bots/ctxd` is a lightweight Slack-link assistant. Send a Slack URL and it
fetches the thread once, stores the markdown context in KV, then lets the user
choose one action: summarize, translate, or draft a reply.

Required secrets:

```bash
cd bots/ctxd
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm wrangler secret put LLM_API_KEY
pnpm wrangler secret put SLACK_USER_TOKEN
pnpm wrangler secret put CLAW_WORKER_SECRET
```

Required vars and bindings live in `bots/ctxd/wrangler.toml`:

- `ALLOWED_CHAT_ID`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `CTXD_SESSIONS` KV namespace

Deploy:

```bash
cd bots/ctxd
pnpm deploy
```

Register the Telegram webhook:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  --data-urlencode "url=https://ctxd-bot.<your-subdomain>.workers.dev/webhook" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

For clawbot integration, set `WORKER_URL_CTXD` to the ctxd worker's `/ilink`
endpoint and use the same `CLAW_WORKER_SECRET` on both sides. In clawbot ctxd
mode, send a Slack URL first, then reply with `1` for summarize, `2` for
translate, or `3` for draft reply.

## Adding a new bot

1. `mkdir -p bots/<name>/src`
2. Copy `bots/katakana/{package.json,wrangler.toml,tsconfig.json}` and edit `name`
3. `pnpm install` to wire the workspace
4. Add secrets via `pnpm wrangler secret put ...`
