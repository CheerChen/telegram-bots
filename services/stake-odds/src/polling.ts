import { answerCallbackQuery, sendMessage } from "shared/telegram";

// Long-polling loop that:
//  1. Acks callback_query events so inline keyboard buttons don't spin.
//  2. Sends a playful message to the chat when someone taps a button,
//     with a per-user cooldown to prevent spam.

interface CallbackUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface CallbackQuery {
  id: string;
  from?: CallbackUser;
  data?: string;
  message?: {
    message_id: number;
    chat?: { id: number | string };
    message_thread_id?: number;
  };
}

interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

const PLAYFUL_LINES = [
  "{user} 有点手痒，点了 {button}！",
  "{user} 似乎对 {button} 有点兴趣...",
  "{user} 忍不住戳了一下 {button}",
  "{user} 觉得 {button} 值得一搏？",
  "{user} 对 {button} 心动了一下",
  "{user} 悄悄点了 {button}，以为没人看见",
  "{user} 在 {button} 上犹豫了 0.3 秒",
  "{user} 用手指给 {button} 投了一票",
  "{user} 被 {button} 勾住了眼神",
  "{user} 点了 {button}，钱包瑟瑟发抖",
];

const COOLDOWN_MS = 30_000;

export class CallbackPoller {
  private offset = 0;
  private running = false;
  private lastTrigger: Map<number, number> = new Map();

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
            await this.handleCallback(u.callback_query);
          }
        }
      } catch (err) {
        this.log(`polling error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(5000);
      }
    }
  }

  private async handleCallback(cq: CallbackQuery): Promise<void> {
    // Always ack first to stop the spinner.
    await answerCallbackQuery(this.token, cq.id).catch((e) =>
      this.log(`answerCallbackQuery: ${String(e)}`),
    );

    const user = cq.from;
    const button = cq.data?.trim();
    const chatId = cq.message?.chat?.id;
    const threadId = cq.message?.message_thread_id;
    const replyToMessageId = cq.message?.message_id;
    if (!user || !button || !chatId || button === "noop") return;

    // Per-user cooldown.
    const now = Date.now();
    const last = this.lastTrigger.get(user.id) ?? 0;
    if (now - last < COOLDOWN_MS) return;
    this.lastTrigger.set(user.id, now);

    // Pick a random playful line and send it to the chat.
    const name = user.first_name || user.username || "某人";
    const template = PLAYFUL_LINES[Math.floor(Math.random() * PLAYFUL_LINES.length)]!;
    const text = template.replace("{user}", name).replace("{button}", button);
    try {
      await sendMessage(this.token, {
        chatId,
        messageThreadId: threadId,
        replyToMessageId,
        text,
        disableWebPagePreview: true,
      });
    } catch (err) {
      this.log(`playful reply: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
