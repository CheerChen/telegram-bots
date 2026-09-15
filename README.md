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
Telegram bot that takes Slack links and returns summaries, translations, or draft replies.

`bots/xvideo/`
Telegram bot for X/Twitter and Weibo video extraction and delivery.

`bots/xvideo-line/`
LINE version of the X/Twitter video bot.

`bots/stagewatch/`
Scheduled Worker that watches artist and event news pages, deduplicates updates in KV, and pushes new items to Telegram.

`bots/toho-ticket/`
Scheduled Worker (every 5 min) that monitors TOHO Cinemas for ticket availability. Subscriptions at the theater+date+movie level, all state in a single KV key. Clock-driven polling before opening, status-driven after. Notifies on opening, 残席わずか, 満席, and 満席解放. Seat maps render as PNG with per-row available counts, refreshed in-place via `editMessageMedia`.

`bots/daily-checkin/`
Scheduled Worker that posts the daily work check-in to Slack (weekdays 10:00 JST): Outlook calendar via Graph API + Jira sprint tickets.

`services/herdbot/`
Telegram agent bot that takes Slack / GitHub PR / Jira / Confluence links, shells out to the `ctxd` CLI for full-context fetches, and runs a Claude Agent SDK loop for multi-turn conversation. Runs on the home Pi via Docker.

`services/clawbot/`
Long-running WeChat bridge service that connects ilink with the ctxd worker.

`services/stake-odds/`
Long-running Stake soccer odds watcher. Polls the fixture list every 10 minutes and pushes a Telegram alert when odds move beyond a threshold. Runs on the home Pi.

`services/pokemon-stock/`
Long-running Pokémon Center Online stock monitor. Polls product pages and pushes a Telegram alert when a target transitions to available. Runs on the home Pi.
