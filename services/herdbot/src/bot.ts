import { Bot, InlineKeyboard, type Context } from "grammy";

import type { HerdConfig } from "./config.ts";
import { runAgentTurn } from "./agent.ts";
import { IDLE_PAGE_TURNED_NOTE, SessionStore } from "./session.ts";

const TG_MAX_LEN = 3900;
const URL_RE = /https?:\/\/\S+/g;
const RESUME_CALLBACK = "resume";

function cleanUrl(raw: string): string {
  return raw.replace(/^</, "").replace(/>$/, "").replace(/[),.;，。！？!?]+$/g, "");
}

function extractFirstUrl(text: string): { url?: string; multiple: boolean } {
  const urls = Array.from(text.matchAll(URL_RE), (m) => cleanUrl(m[0])).filter(Boolean);
  if (urls.length === 0) return { multiple: false };
  if (urls.length > 1) return { multiple: true };
  return { url: urls[0], multiple: false };
}

function truncate(text: string): string {
  return text.length > TG_MAX_LEN ? `${text.slice(0, TG_MAX_LEN - 14)}\n…（已截断）` : text;
}

export interface BotDeps {
  config: HerdConfig;
  sessions: SessionStore;
}

export function createBot({ config, sessions }: BotDeps): Bot {
  const bot = new Bot(config.telegramBotToken);

  // --- Chat whitelist ---
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || String(chatId) !== config.allowedChatId) {
      return;
    }
    await next();
  });

  // --- /start, /help ---
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "发送 Slack / GitHub PR / Jira / Confluence 链接，我会抓取内容并总结。之后可以继续追问。",
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "发送链接 → 自动抓取 + 总结\n/new → 立刻开始新会话\n闲置超时自动翻篇，可点按钮继续上一个会话",
      { link_preview_options: { is_disabled: true } },
    );
  });

  // --- /new — force page-turn ---
  bot.command("new", async (ctx) => {
    await sessions.delete(ctx.chat.id);
    await ctx.reply("已开始新会话。请发送链接。", { link_preview_options: { is_disabled: true } });
  });

  // --- Callback query: resume previous session ---
  bot.callbackQuery(RESUME_CALLBACK, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    await ctx.answerCallbackQuery();

    const stashed = await sessions.get(chatId);
    if (!stashed?.pendingReplay || !stashed.sessionId) {
      await ctx.reply("上一个会话已不可恢复。请发送链接开始新会话。", {
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    const { sessionId: oldSessionId, pendingReplay: replayText } = stashed;
    await sessions.delete(chatId);

    await handleAgentTurn(ctx, chatId, replayText, oldSessionId, false, "正在继续上一个会话…");
  });

  // --- Text messages ---
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();

    const { url, multiple } = extractFirstUrl(text);
    if (multiple) {
      await ctx.reply("一次请只发送一个链接。", { link_preview_options: { is_disabled: true } });
      return;
    }
    if (url) {
      await handleUrl(ctx, chatId, text);
      return;
    }
    await handleFollowUp(ctx, chatId, text);
  });

  bot.catch((err) => {
    console.error("bot error", err.error);
  });

  // --- Inner handlers (close over config + sessions) ---

  async function handleUrl(
    ctx: Context,
    chatId: number,
    rawText: string,
  ): Promise<void> {
    // 1. Idle check
    const idleCheck = await sessions.checkIdle(chatId);
    let resumeSessionId: string | undefined;
    let isFirstTurn = true;

    if (idleCheck.expired) {
      const kb = new InlineKeyboard().text("继续上一个会话", RESUME_CALLBACK);
      await ctx.reply(
        `${IDLE_PAGE_TURNED_NOTE}\n\n你发送的链接会在新会话中处理。如需在旧会话中继续，点下方按钮。`,
        { reply_markup: kb, link_preview_options: { is_disabled: true } },
      );
      await sessions.setPendingReplay(chatId, idleCheck.previousSessionId, rawText);
    } else if (idleCheck.session) {
      resumeSessionId = idleCheck.session.sessionId;
      isFirstTurn = false;
    }

    // 2. Hand the raw message to the agent. The agent fetches the URL itself
    //    via its ctxd Bash tool — the bridge never pre-fetches, so the agent
    //    stays in charge of what to fetch (including follow-up expansions).
    await handleAgentTurn(ctx, chatId, rawText, resumeSessionId, isFirstTurn, "正在读取链接…");
  }

  async function handleFollowUp(ctx: Context, chatId: number, text: string): Promise<void> {
    const idleCheck = await sessions.checkIdle(chatId);
    if (idleCheck.expired) {
      const kb = new InlineKeyboard().text("继续上一个会话", RESUME_CALLBACK);
      await sessions.setPendingReplay(chatId, idleCheck.previousSessionId, text);
      await ctx.reply(
        `${IDLE_PAGE_TURNED_NOTE}\n\n你的问题会在新会话中处理。如需在旧会话中继续，点下方按钮。`,
        { reply_markup: kb, link_preview_options: { is_disabled: true } },
      );
      return;
    }

    if (!idleCheck.session) {
      await ctx.reply("请发送 Slack / GitHub PR / Jira / Confluence 链接开始对话。", {
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    await handleAgentTurn(
      ctx,
      chatId,
      text,
      idleCheck.session.sessionId,
      false,
      "思考中…",
    );
  }

  /**
   * Shared agent-turn runner: sends a progress message, streams updates,
   * persists the session pointer on success.
   */
  async function handleAgentTurn(
    ctx: Context,
    chatId: number,
    prompt: string,
    resumeSessionId: string | undefined,
    isFirstTurn: boolean,
    initialProgressText: string,
  ): Promise<void> {
    const progressMsg = await ctx.reply(initialProgressText, {
      link_preview_options: { is_disabled: true },
    });

    try {
      const result = await runAgentTurn({
        config,
        prompt,
        resumeSessionId,
        isFirstTurn,
        cwd: config.dataDir,
        onProgress: (progressText) => {
          void ctx.api
            .editMessageText(chatId, progressMsg.message_id, truncate(progressText), {
              link_preview_options: { is_disabled: true },
            })
            .catch(() => {});
        },
      });

      await sessions.touch(chatId, result.sessionId);
      // The final editMessageText may fail with "message is not modified" if
      // the last onProgress callback already wrote the same text. That's fine —
      // the message already shows the correct content.
      await ctx.api
        .editMessageText(chatId, progressMsg.message_id, truncate(result.text), {
          link_preview_options: { is_disabled: true },
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("is not modified")) throw e;
        });
    } catch (e) {
      console.error("agent turn failed", e);
      await ctx.api.editMessageText(chatId, progressMsg.message_id, "处理失败。请再试一次。", {
        link_preview_options: { is_disabled: true },
      });
    }
  }

  return bot;
}
