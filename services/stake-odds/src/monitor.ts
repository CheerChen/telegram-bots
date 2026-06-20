import { escapeHtml, sendMessage } from "shared/telegram";
import type { InlineKeyboardMarkup } from "shared/telegram";

import type { StakeOddsConfig } from "./config.ts";
import { CredentialError, type Fixture, type MarketLine } from "./stake.ts";
import { fetchFixtures } from "./stake.ts";
import { marketsToSnapshot, type FixtureSnapshot, type MarketsSnapshot, type StakeOddsState, type StateStore } from "./state.ts";

// Stake returns Chinese status values (X-Language: zh). Live matches are
// skipped to avoid rapid-fire odds churn driven by live score movement.
const LIVE_STATUS = new Set(["live", "inplay", "in_play"]);
const LIVE_MATCH_STATUS = new Set([
  "上半场",
  "下半场",
  "中场",
  "中场休息",
  "加时赛",
  "点球大战",
  "暂停",
  "inplay",
  "halftime",
  "half_time",
]);

// Finished / no-longer-relevant statuses → drop the snapshot.
const FINISHED_STATUS = new Set(["ended", "finished", "closed", "cancelled", "canceled", "abandoned", "postponed", "voided"]);
const FINISHED_MATCH_STATUS = new Set([
  "已结束",
  "结束",
  "完场",
  "已取消",
  "取消",
  "弃权",
  "延期",
  "ended",
  "finished",
  "cancelled",
  "postponed",
]);

export interface CycleStats {
  at: string;
  league: string | null;
  watched: number;
  live: number;
  finished: number;
  notified: number;
  seeded: number;
  idle: boolean;
  credentialAlert: boolean;
  errors: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isLive(fixture: Fixture): boolean {
  const st = fixture.status?.toLowerCase();
  if (st && LIVE_STATUS.has(st)) return true;
  const ms = fixture.matchStatus;
  if (ms && LIVE_MATCH_STATUS.has(ms)) return true;
  return false;
}

function isFinished(fixture: Fixture): boolean {
  const st = fixture.status?.toLowerCase();
  if (st && FINISHED_STATUS.has(st)) return true;
  const ms = fixture.matchStatus;
  if (ms && FINISHED_MATCH_STATUS.has(ms)) return true;
  return false;
}

function leagueMatches(league: string | null, keywords: string[]): boolean {
  if (!league) return false;
  const lower = league.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function relativeChange(oldOdds: number, newOdds: number): number {
  if (oldOdds === 0) return newOdds === 0 ? 0 : 1;
  return Math.abs(newOdds - oldOdds) / oldOdds;
}

// Compare two outcome lists by name, return the outcomes whose odds crossed
// the threshold. Outcomes are matched by name (not index) because Stake may
// reorder or rename handicap lines.
interface OutcomeDelta {
  name: string;
  oldOdds: number;
  newOdds: number;
  crossed: boolean;
}

function diffMarket(oldLine: { outcomes: { name: string; odds: number }[] } | undefined, newLine: MarketLine, threshold: number): OutcomeDelta[] {
  const oldByName = new Map(oldLine?.outcomes.map((o) => [o.name, o.odds]) ?? []);
  return newLine.outcomes.map((o) => {
    const oldOdds = oldByName.get(o.name);
    const crossed = oldOdds !== undefined && relativeChange(oldOdds, o.odds) > threshold;
    return {
      name: o.name,
      oldOdds: oldOdds ?? o.odds,
      newOdds: o.odds,
      crossed,
    };
  });
}

function fmtOdds(v: number): string {
  return v.toFixed(2);
}

function fmtStartTime(iso: string | null): string {
  if (!iso) return "未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { timeZone: TZ, hour12: false });
}

// Watch window: fixtures whose startTime falls in [now, now + 24h).
// Rolling 24h window from the current cycle time — fixtures enter as their
// kick-off approaches and roll out 24h later. Fixtures outside this window
// are snapshotted silently but not watched.
const TZ = "Asia/Tokyo";
const WINDOW_MS = 24 * 60 * 60 * 1000;

function inWatchWindow(startTime: string | null, now: Date): boolean {
  if (!startTime) return false;
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return false;
  const t = start.getTime();
  return t >= now.getTime() && t < now.getTime() + WINDOW_MS;
}

function fixtureHeaderHtml(fixture: Fixture): string {
  const league = escapeHtml(fixture.league ?? "Stake");
  const home = escapeHtml(fixture.homeTeam ?? "?");
  const away = escapeHtml(fixture.awayTeam ?? "?");
  return `⚽ <b>${league}</b> · <b>${home}</b> vs <b>${away}</b>`;
}

async function notifyMarketChange(
  config: StakeOddsConfig,
  fixture: Fixture,
  template: string,
  deltas: OutcomeDelta[],
): Promise<void> {
  const text = [
    `📈 ${fixtureHeaderHtml(fixture)}`,
    `🕐 ${escapeHtml(fmtStartTime(fixture.startTime))}  ·  <b>${escapeHtml(template)}</b>`,
  ].join("\n");
  // Each outcome as a button row. Changed outcomes show old→new + arrow.
  const rows = deltas.map((d) => {
    if (d.crossed) {
      const pct = Math.round(((d.newOdds - d.oldOdds) / d.oldOdds) * 100);
      const arrow = d.newOdds < d.oldOdds ? "⬇" : "⬆";
      return [{
        text: `${d.name}  ${fmtOdds(d.oldOdds)}→${fmtOdds(d.newOdds)} ${arrow}${pct}%`,
        callback_data: "noop",
      }];
    }
    return [{ text: `${d.name}  ${fmtOdds(d.newOdds)}`, callback_data: "noop" }];
  });
  const markup: InlineKeyboardMarkup = { inline_keyboard: rows };
  await sendMessage(config.telegramBotToken, {
    chatId: config.telegramChatId,
    messageThreadId: config.telegramMessageThreadId,
    text,
    parseMode: "HTML",
    disableWebPagePreview: true,
    replyMarkup: markup,
  });
}

async function notifySeed(config: StakeOddsConfig, fixture: Fixture): Promise<void> {
  const text = [
    `${fixtureHeaderHtml(fixture)}`,
    `🕐 ${escapeHtml(fmtStartTime(fixture.startTime))}`,
  ].join("\n");
  // Each market template = one row of outcome buttons.
  const rows = fixture.markets.map((m) =>
    m.outcomes.map((o) => ({
      text: `${o.name} ${fmtOdds(o.odds)}`,
      callback_data: "noop",
    })),
  );
  const markup: InlineKeyboardMarkup = { inline_keyboard: rows };
  await sendMessage(config.telegramBotToken, {
    chatId: config.telegramChatId,
    messageThreadId: config.telegramMessageThreadId,
    text,
    parseMode: "HTML",
    disableWebPagePreview: true,
    replyMarkup: markup,
  });
}

async function notifyCredentialAlert(config: StakeOddsConfig, detail: string): Promise<void> {
  await sendMessage(config.telegramBotToken, {
    chatId: config.telegramChatId,
    messageThreadId: config.telegramMessageThreadId,
    text: `⚠️ Stake 凭证可能过期，请刷新 cf_clearance / access_token。\n${escapeHtml(detail)}`,
    parseMode: "HTML",
    disableWebPagePreview: true,
  });
}

function toSnapshot(fixture: Fixture, seededAt: string, seeded: boolean, lastNotifiedAt?: string): FixtureSnapshot {
  return {
    id: fixture.id,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    startTime: fixture.startTime,
    league: fixture.league,
    markets: marketsToSnapshot(fixture.markets),
    seededAt,
    seeded,
    lastNotifiedAt,
  };
}

export async function runCycle(config: StakeOddsConfig, store: StateStore): Promise<CycleStats> {
  const stats: CycleStats = {
    at: nowIso(),
    league: null,
    watched: 0,
    live: 0,
    finished: 0,
    notified: 0,
    seeded: 0,
    idle: false,
    credentialAlert: false,
    errors: [],
  };

  const state = await store.load();

  let league: string | null;
  let fixtures: Fixture[];
  try {
    const result = await fetchFixtures(config);
    league = result.league;
    fixtures = result.fixtures;
  } catch (err) {
    if (err instanceof CredentialError) {
      stats.errors.push(`credential: ${err.message}`);
      const last = state.lastCredentialAlertAt ? Date.parse(state.lastCredentialAlertAt) : 0;
      const cooledDown = Date.now() - last > config.credentialAlertCooldownMs;
      if (cooledDown) {
        try {
          await notifyCredentialAlert(config, err.message);
          state.lastCredentialAlertAt = nowIso();
          stats.credentialAlert = true;
        } catch (notifyErr) {
          stats.errors.push(`credential-alert failed: ${String(notifyErr)}`);
        }
      }
      await store.save(state).catch((e) => stats.errors.push(`state save: ${String(e)}`));
    } else {
      stats.errors.push(`fetch: ${err instanceof Error ? err.message : String(err)}`);
    }
    return stats;
  }

  stats.league = league;

  // Silent idle when the popular tournament isn't one we care about.
  if (!leagueMatches(league, config.tournamentKeywords)) {
    stats.idle = true;
    await store.save(state).catch((e) => stats.errors.push(`state save: ${String(e)}`));
    return stats;
  }

  const currentIds = new Set(fixtures.map((f) => f.id));

  // Prune snapshots for fixtures that disappeared from the feed.
  for (const [id] of Object.entries(state.fixtures)) {
    if (!currentIds.has(id)) {
      delete state.fixtures[id];
      stats.finished += 1;
    }
  }

  const cycleNow = new Date();

  for (const fixture of fixtures) {
    if (isFinished(fixture)) {
      if (state.fixtures[fixture.id]) {
        delete state.fixtures[fixture.id];
        stats.finished += 1;
      }
      continue;
    }
    if (isLive(fixture)) {
      stats.live += 1;
      // Do not touch the snapshot while live — avoids false change alerts
      // once the match ends and pre-match odds return.
      continue;
    }
    if (fixture.markets.length === 0) continue;

    const inWindow = inWatchWindow(fixture.startTime, cycleNow);
    const prev = state.fixtures[fixture.id];

    // Outside the watch window: silently (re)write the snapshot so future
    // diffs have a baseline, but never seed or notify. Preserve the seeded
    // flag so we don't re-seed when the fixture re-enters the window.
    if (!inWindow) {
      state.fixtures[fixture.id] = toSnapshot(
        fixture,
        prev?.seededAt ?? nowIso(),
        prev?.seeded ?? false,
        prev?.lastNotifiedAt,
      );
      continue;
    }

    stats.watched += 1;

    // First in-window sighting without a prior seed: push the baseline.
    // Only mark seeded=true after the Telegram push succeeds, so a transient
    // Telegram outage retries the seed on the next cycle.
    if (!prev || !prev.seeded) {
      try {
        await notifySeed(config, fixture);
        state.fixtures[fixture.id] = toSnapshot(fixture, nowIso(), true);
        stats.seeded += 1;
      } catch (err) {
        // Still snapshot so future change-diffs have a baseline, but keep
        // seeded=false so we retry the seed message next cycle.
        state.fixtures[fixture.id] = toSnapshot(fixture, prev?.seededAt ?? nowIso(), false);
        stats.errors.push(`seed notify ${fixture.id}: ${String(err)}`);
      }
      continue;
    }

    // Per-template diff. Each template that has any crossed outcome gets its
    // own Telegram message.
    let anyNotified = false;
    for (const newLine of fixture.markets) {
      const oldLine = prev.markets[newLine.template];
      const deltas = diffMarket(oldLine, newLine, config.oddsChangeThreshold);
      if (!deltas.some((d) => d.crossed)) continue;
      try {
        await notifyMarketChange(config, fixture, newLine.template, deltas);
        stats.notified += 1;
        anyNotified = true;
      } catch (err) {
        stats.errors.push(`change notify ${fixture.id}/${newLine.template}: ${String(err)}`);
      }
    }

    state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, anyNotified ? nowIso() : prev.lastNotifiedAt);
  }

  await store.save(state).catch((e) => stats.errors.push(`state save: ${String(e)}`));
  return stats;
}
