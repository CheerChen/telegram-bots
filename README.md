# telegram-bots

Monorepo for personal bots and related services.

## Structure

`packages/shared/`
Shared helpers for Telegram, LINE, auth, sessions, and other reusable client logic.

`packages/ilink/`
WeChat bot protocol support used by the clawbot bridge.

`bots/katakana/`
Telegram bot for CN/EN word lookup into Japanese reading / Katakana output.

`bots/katakana-line/`
LINE version of the katakana lookup bot.

`bots/ctxd/`
Telegram bot that takes Slack links and returns summaries, translations, or draft replies. Also serves `/ilink` as the Q&A backend for clawbot.

`bots/xvideo/`
Telegram bot for X/Twitter and Weibo video extraction and delivery.

`bots/xvideo-line/`
LINE version of the X/Twitter video bot.

`bots/stagewatch/`
Scheduled Worker that watches artist and event news pages, deduplicates updates in KV, and pushes new items to Telegram.

`bots/toho-ticket/`
Scheduled Worker (every 5 min) that monitors TOHO Cinemas for ticket availability. Subscriptions at the theater+date+movie level, all state in a single KV key. Clock-driven polling before opening, status-driven after. Notifies on opening, 残席わずか, 満席, and 満席解放. Seat maps render as PNG with per-row available counts, refreshed in-place via `editMessageMedia`.

`bots/daily-checkin/`
Scheduled Worker that posts the daily work check-in to Slack (weekdays 09:55 JST, one in-run retry ~5 min later that alerts on failure): Outlook calendar via Graph API + Jira sprint tickets.

`bots/gmail-lifecycle/`
Scheduled Worker (daily, D1-backed) that manages domain-based Gmail labels: promotes busy domains, archives stale ones, wakes them on new mail, and eventually deletes them.

`services/clawbot/`
Long-running WeChat bridge service that connects ilink with the ctxd worker. Runs on the home Pi via Docker; deployed manually (`make release` in the service dir, then `docker compose pull && up -d` in the Pi stack dir).

## Archives

No longer deployed; kept for reference. Not part of the pnpm workspace.

`archives/herdbot/`
Telegram agent bot that shelled out to the `ctxd` CLI and ran a Claude Agent SDK loop for multi-turn conversation.

`archives/stake-odds/`, `archives/stake-odds-callback/`
Stake soccer odds watcher and its callback_query Worker.

`archives/pokemon-stock/`
Pokémon Center Online stock monitor.
