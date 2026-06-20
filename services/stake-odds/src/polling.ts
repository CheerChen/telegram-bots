import { answerCallbackQuery } from "shared/telegram";

// Minimal long-polling loop: swallow callback_query events so inline keyboard
// buttons don't show a spinning loader + timeout on the client. We don't act
// on the buttons — they're display-only — but Telegram requires an
// answerCallbackQuery ack to stop the spinner.

interface Update {
  update_id: number;
  callback_query?: { id: string };
}

export class CallbackPoller {
  private offset = 0;
  private running = false;

  constructor(
    private readonly token: string,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=30`,
          { method: "GET" },
        );
        if (!res.ok) {
          this.log(`polling getUpdates ${res.status}`);
          await sleep(5000);
          continue;
        }
        const body = (await res.json()) as { ok: boolean; result?: Update[] };
        const updates = body.result ?? [];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) {
            // Empty ack — stops the spinner, no user-visible toast.
            await answerCallbackQuery(this.token, u.callback_query.id).catch((e) =>
              this.log(`answerCallbackQuery: ${String(e)}`),
            );
          }
        }
      } catch (err) {
        this.log(`polling error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(5000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
