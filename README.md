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
Telegram bot for X/Twitter video extraction and delivery.

`bots/xvideo-line/`
LINE version of the X/Twitter video bot.

`bots/stagewatch/`
Scheduled Worker that watches artist and event news pages, deduplicates updates in KV, and pushes new items to Telegram.

`services/clawbot/`
Long-running WeChat bridge service that connects ilink with the ctxd worker.

`services/stake-odds/`
Long-running Stake soccer odds watcher. Polls the popular tournament's fixture list every 10 minutes, watches the day's World Cup matches, and pushes a Telegram alert when any threeway odds line moves more than the configured threshold. Live matches are skipped; finished matches drop off the watchlist. Runs on the home Pi (same exit IP as the `cf_clearance` credential).
