# daily-checkin

One-shot Slack check-in bot: Outlook calendar (Graph API, ICS fallback) +
Jira sprint tickets → Slack DM. Runs daily at 10:00 JST via in-container
shell scheduler.

## Tech stack

- TypeScript + tsx (no compile step)
- `@azure/msal-node` for Graph API auth (Authorization Code + PKCE)
- `ical.js` for ICS parsing + RRULE expansion
- Docker (node:22-alpine, arm64 for Pi)

## Deploy

```sh
make pi-deploy   # rsync source to Pi, then docker compose up --build
make pi-logs     # tail logs
make pi-test     # one-shot run (bypasses scheduler window)
```

## Token refresh

The MSAL cache (`state/.msal_cache.json`) expires periodically. When it does,
the bot falls back to ICS and sends a Slack DM alert. To refresh:

```sh
make auth        # local interactive login, writes state/.msal_cache.json
# then scp to Pi:
scp state/.msal_cache.json pi:/opt/stacks/daily-checkin/state/
```

## Env vars

See `.env.example`. The `.env` file lives only on the Pi
(`/opt/stacks/daily-checkin/.env`), never in git.
