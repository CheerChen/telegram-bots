// Telegram reporting for the daily cron: the only signal that the lifecycle is
// actually running, since label moves alone are easy to miss.
//
//   - A day with label changes, failures or errors → one summary message.
//   - A quiet day → nothing, except on HEARTBEAT_UTC_DAY, when a short
//     "still alive" message is sent. A missing weekly heartbeat means the
//     cron itself stopped firing.
//   - runCycle throwing outright → an alert via reportCrash.
//
// Without TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID the report is only logged, so
// the worker keeps running before the secrets are set.

import type { D1Database } from "@cloudflare/workers-types";
import { escapeHtml, sendMessage } from "shared/telegram";
import type { RunStats } from "./index";

export interface ReportEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

// Monday. The cron fires at 03:00 UTC, which is the same calendar day in JST.
const HEARTBEAT_UTC_DAY = 1;
// Keep messages well under Telegram's 4096-char limit.
const MAX_LIST_ITEMS = 15;
const MAX_ERRORS = 5;
const MAX_ERROR_CHARS = 200;

function hasActivity(stats: RunStats): boolean {
  return (
    stats.wake.woken.length > 0 ||
    stats.promote.promoted.length > 0 ||
    stats.evict.archived.length > 0 ||
    stats.evict.deleted.length > 0 ||
    stats.wake.failed.length > 0 ||
    stats.promote.failed.length > 0 ||
    stats.evict.failed.length > 0 ||
    stats.errors.length > 0
  );
}

function listLine(icon: string, label: string, items: string[]): string | null {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_LIST_ITEMS).map(escapeHtml).join(", ");
  const more = items.length > MAX_LIST_ITEMS ? ` …+${items.length - MAX_LIST_ITEMS}` : "";
  return `${icon} ${label} (${items.length}): ${shown}${more}`;
}

async function countByState(db: D1Database): Promise<Record<string, number>> {
  const res = await db
    .prepare("SELECT state, COUNT(*) AS n FROM domains GROUP BY state")
    .all<{ state: string; n: number }>();
  const out: Record<string, number> = {};
  for (const row of res.results ?? []) out[row.state] = row.n;
  return out;
}

function stateLine(byState: Record<string, number>): string {
  const parts = Object.entries(byState).map(([state, n]) => `${escapeHtml(state)} ${n}`);
  return parts.length ? `追踪中域名：${parts.join(" / ")}` : "追踪中域名：0";
}

function scanLine(stats: RunStats): string {
  return `扫描 ${stats.scan.scanned} 封（列出 ${stats.scan.listed}，已处理跳过 ${stats.scan.skipped}）`;
}

function composeActivity(stats: RunStats): string {
  const failed = [
    ...stats.wake.failed.map((d) => `wake:${d}`),
    ...stats.promote.failed.map((d) => `promote:${d}`),
    ...stats.evict.failed.map((d) => `evict:${d}`),
  ];
  const lines = [
    stats.errors.length || failed.length ? "⚠️ <b>gmail-lifecycle</b>（有失败）" : "📬 <b>gmail-lifecycle</b>",
    scanLine(stats),
    listLine("🆕", "新建标签", stats.promote.promoted),
    listLine("⏰", "唤醒", stats.wake.woken),
    listLine("😴", "归档", stats.evict.archived),
    listLine("🗑", "删除", stats.evict.deleted),
    listLine("⏳", "推迟新建", stats.promote.deferred),
    listLine("❌", "失败", failed),
  ].filter((l): l is string => l !== null);
  if (stats.errors.length) {
    lines.push(`❗ 错误 (${stats.errors.length})：`);
    for (const e of stats.errors.slice(0, MAX_ERRORS)) {
      lines.push(`<code>${escapeHtml(e.slice(0, MAX_ERROR_CHARS))}</code>`);
    }
    if (stats.errors.length > MAX_ERRORS) lines.push(`…+${stats.errors.length - MAX_ERRORS}`);
  }
  return lines.join("\n");
}

async function send(env: ReportEnv, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log(`[report] telegram not configured; would send:\n${text}`);
    return;
  }
  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId: env.TELEGRAM_CHAT_ID,
    text,
    parseMode: "HTML",
    disableWebPagePreview: true,
  });
}

export async function reportCycle(env: ReportEnv, stats: RunStats, now = new Date()): Promise<void> {
  if (hasActivity(stats)) {
    await send(env, composeActivity(stats));
    return;
  }
  if (now.getUTCDay() !== HEARTBEAT_UTC_DAY) {
    console.log("[report] quiet day; no message");
    return;
  }
  const byState = await countByState(env.DB);
  await send(env, ["✅ <b>gmail-lifecycle</b> 每周心跳：运行正常，今日无变动", scanLine(stats), stateLine(byState)].join("\n"));
}

export async function reportCrash(env: ReportEnv, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  await send(env, `🚨 <b>gmail-lifecycle</b> 运行失败\n<code>${escapeHtml(msg.slice(0, MAX_ERROR_CHARS))}</code>`);
}
