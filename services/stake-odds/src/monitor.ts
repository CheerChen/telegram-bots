import { deleteMessage, editMessageText, escapeHtml, sendMessage } from "shared/telegram";
import type { InlineKeyboardMarkup } from "shared/telegram";

import type { StakeOddsConfig } from "./config.ts";
import { CredentialError, type Fixture } from "./stake.ts";
import { fetchFixtures } from "./stake.ts";
import { type FixtureSnapshot, type MarketsSnapshot, type StateStore } from "./state.ts";

// Stake returns Chinese status values (X-Language: zh).
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
  edited: number;
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

function fmtOdds(v: number): string {
  return v.toFixed(2);
}

// Shorten outcome names for inline keyboard buttons (mobile truncates long
// button text). Only the team-name portion is shortened (>= 4 chars → first 2);
// trailing parameters in parentheses (handicap lines) or numeric thresholds
// (over/under) are preserved. Message body always uses full names.
function shortName(name: string): string {
  // "荷兰 (0)" → shorten "荷兰", keep " (0)"
  const m = name.match(/^(.+?)\s*(\(.*)$/);
  if (m) {
    const team = m[1]!.length >= 4 ? m[1]!.slice(0, 2) : m[1]!;
    return `${team} ${m[2]}`;
  }
  // "高于1.75" / "低于1.75" — keep as-is (no team name to shorten)
  if (/^[高低上下大小]/.test(name)) return name;
  // Plain team name
  return name.length >= 4 ? name.slice(0, 2) : name;
}

const TZ = "Asia/Tokyo";
const WINDOW_MS = 24 * 60 * 60 * 1000;

function fmtStartTime(iso: string | null): string {
  if (!iso) return "未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { timeZone: TZ, hour12: false });
}

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

// Same as fixtureHeaderHtml but from a snapshot (no Fixture object available
// during prune).
function fixtureHeaderFromSnapshot(s: FixtureSnapshot): string {
  const league = escapeHtml(s.league ?? "Stake");
  const home = escapeHtml(s.homeTeam ?? "?");
  const away = escapeHtml(s.awayTeam ?? "?");
  return `⚽ <b>${league}</b> · <b>${home}</b> vs <b>${away}</b>`;
}

// Estimate the match minute from startTime + matchStatus. Stake doesn't
// provide a precise clock, so we approximate from elapsed wall time.
// Halftime is assumed ~15 min. Extra time / penalties are shown as-is.
function fmtLiveLine(fixture: Fixture): string {
  if (isFinished(fixture)) {
    const score = `${fixture.homeScore ?? 0}-${fixture.awayScore ?? 0}`;
    return `🏁 ${score}  比赛结束`;
  }
  if (!isLive(fixture)) return "";
  const score = `${fixture.homeScore ?? 0}-${fixture.awayScore ?? 0}`;
  const ms = fixture.matchStatus ?? "";
  const HALF_TIME_MS = 45 * 60 * 1000;
  const HALFTIME_MS = 15 * 60 * 1000;
  if (fixture.startTime) {
    const start = new Date(fixture.startTime).getTime();
    const elapsed = Date.now() - start;
    if (ms === "上半场") {
      const min = Math.min(Math.floor(elapsed / 60000), 45);
      return `🏁 ${score}  上半场 ${min}'`;
    }
    if (ms === "中场" || ms === "中场休息") {
      return `🏁 ${score}  中场`;
    }
    if (ms === "下半场") {
      const min = Math.min(45 + Math.floor((elapsed - HALF_TIME_MS - HALFTIME_MS) / 60000), 90);
      return `🏁 ${score}  下半场 ${min}'`;
    }
    if (ms === "加时赛") {
      const min = Math.min(Math.floor((elapsed - 90 * 60000) / 60000), 30);
      return `🏁 ${score}  加时 ${min}'`;
    }
    if (ms === "点球大战") {
      return `🏁 ${score}  点球大战`;
    }
  }
  return `🏁 ${score}  ${ms}`;
}

// --- Single-message rendering ---
// One message per fixture. The text shows header + start time (+ live badge).
// The inline keyboard shows all market outcomes, one row per template.
// When odds changed, the button shows old→new + arrow + pct.
// When the lineup changed (handicap moved etc.), the button just shows the
// new outcome — no history marker.

interface OutcomeRender {
  name: string;
  odds: number;
  // Previous odds if this outcome existed in the old snapshot.
  oldOdds?: number;
  // Odds moved more than the notification threshold (>10%) — triggers a
  // separate change-notification message.
  changed: boolean;
  // Odds moved by any amount (even <10%) — triggers a board edit so the
  // board always shows the latest odds.
  shifted: boolean;
}

interface TemplateRender {
  template: string;
  outcomes: OutcomeRender[];
}

function buildTemplateRenders(
  fixture: Fixture,
  prev: FixtureSnapshot | undefined,
  threshold: number,
): TemplateRender[] {
  return fixture.markets.map((m) => {
    const oldLine = prev?.markets[m.template];
    const oldByName = new Map((oldLine?.outcomes ?? []).map((o) => [o.name, o]));
    const outcomes: OutcomeRender[] = m.outcomes.map((o) => {
      const old = oldByName.get(o.name);
      if (old !== undefined) {
        const rel = relativeChange(old.odds, o.odds);
        // changed: cumulative drift from the last notification baseline
        // (notifiedOdds) exceeds the threshold. Falls back to old.odds if
        // notifiedOdds is missing (old state without the field).
        const baseline = old.notifiedOdds ?? old.odds;
        const changed = relativeChange(baseline, o.odds) > threshold;
        return { name: o.name, odds: o.odds, oldOdds: baseline, changed, shifted: rel > 0 };
      }
      // New outcome (lineup change) — no baseline, not "changed" (just new).
      return { name: o.name, odds: o.odds, changed: false, shifted: false };
    });
    return { template: m.template, outcomes };
  });
}

function renderMessageText(fixture: Fixture): string {
  const lines = [
    fixtureHeaderHtml(fixture),
    `🕐 ${escapeHtml(fmtStartTime(fixture.startTime))}`,
  ];
  const liveLine = fmtLiveLine(fixture);
  if (liveLine) lines.push(escapeHtml(liveLine));
  return lines.join("\n");
}

function renderKeyboard(renders: TemplateRender[]): InlineKeyboardMarkup {
  // Each template = one row of outcome buttons. Buttons always show the
  // current odds only — change notifications are sent as separate messages.
  const rows = renders.map((tr) =>
    tr.outcomes.map((o) => ({
      text: `${shortName(o.name)} ${fmtOdds(o.odds)}`,
      callback_data: `${shortName(o.name)} ${fmtOdds(o.odds)}`.slice(0, 64),
    })),
  );
  return { inline_keyboard: rows };
}

// Check if anything changed that warrants an edit: odds, lineup, score, or
// match status (e.g. live → started, goal scored, half changed).
// Treat undefined and null as equal (old snapshots may lack new fields).
function hasAnyChange(fixture: Fixture, renders: TemplateRender[], prev: FixtureSnapshot | undefined): boolean {
  if (!prev) return true; // first sighting → seed
  // Score change
  const prevHome = prev.homeScore ?? null;
  const prevAway = prev.awayScore ?? null;
  if ((fixture.homeScore ?? null) !== prevHome || (fixture.awayScore ?? null) !== prevAway) return true;
  // Match status change (e.g. not-live → live, 上半场 → 下半场)
  if ((fixture.matchStatus ?? null) !== (prev.matchStatus ?? null)) return true;
  for (const tr of renders) {
    const oldLine = prev.markets[tr.template];
    const oldNames = new Set((oldLine?.outcomes ?? []).map((o) => o.name));
    const newNames = new Set(tr.outcomes.map((o) => o.name));
    // Lineup change
    if (oldNames.size !== newNames.size || [...newNames].some((n) => !oldNames.has(n))) return true;
    // Any odds shift (even <10%) — board should always show latest odds.
    if (tr.outcomes.some((o) => o.shifted)) return true;
  }
  return false;
}

async function sendSeedMessage(config: StakeOddsConfig, fixture: Fixture, renders: TemplateRender[]): Promise<number> {
  const text = renderMessageText(fixture);
  const markup = renderKeyboard(renders);
  return sendMessage(config.telegramBotToken, {
    chatId: config.telegramChatId,
    messageThreadId: config.telegramMessageThreadId,
    text,
    parseMode: "HTML",
    disableWebPagePreview: true,
    replyMarkup: markup,
  });
}

async function editFixtureMessage(config: StakeOddsConfig, messageId: number, fixture: Fixture, renders: TemplateRender[]): Promise<void> {
  const text = renderMessageText(fixture);
  const markup = renderKeyboard(renders);
  await editMessageText(config.telegramBotToken, {
    chatId: config.telegramChatId,
    messageId,
    text,
    parseMode: "HTML",
    disableWebPagePreview: true,
    replyMarkup: markup,
  });
}

// Send a change notification for a single template — one message per
// template that has any crossed outcome. Multiple changed outcomes within
// the same template are merged into one message. Returns the message_id
// so it can be tracked for auto-cleanup when the match finishes.
async function notifyOddsChange(
  config: StakeOddsConfig,
  fixture: Fixture,
  template: string,
  changedOutcomes: { name: string; oldOdds: number; newOdds: number }[],
): Promise<number> {
  const home = escapeHtml(fixture.homeTeam ?? "?");
  const away = escapeHtml(fixture.awayTeam ?? "?");
  const tpl = escapeHtml(template);
  const lines = [
    `📈 <b>${home}</b> vs <b>${away}</b> · <b>${tpl}</b>`,
    ...changedOutcomes.map((o) => {
      const pct = Math.round(((o.newOdds - o.oldOdds) / o.oldOdds) * 100);
      const arrow = o.newOdds < o.oldOdds ? "🔻" : "🔺";
      return `${escapeHtml(o.name)} ${fmtOdds(o.oldOdds)} → ${fmtOdds(o.newOdds)} ${arrow}${Math.abs(pct)}%`;
    }),
  ];
  return sendMessage(config.telegramBotToken, {
    chatId: config.telegramChatId,
    messageThreadId: config.telegramMessageThreadId,
    text: lines.join("\n"),
    parseMode: "HTML",
    disableWebPagePreview: true,
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

// Delete all tracked odds-change notification messages for a fixture.
// Errors are swallowed (message may already be deleted by user).
async function deleteNotifyMessages(config: StakeOddsConfig, messageIds: number[]): Promise<void> {
  for (const id of messageIds) {
    try {
      await deleteMessage(config.telegramBotToken, config.telegramChatId, id);
    } catch {
      // Already deleted or not found — ignore.
    }
  }
}

function toSnapshot(
  fixture: Fixture,
  seededAt: string,
  seeded: boolean,
  messageId?: number,
  lastNotifiedAt?: string,
  prev?: FixtureSnapshot,
  renders?: TemplateRender[],
): FixtureSnapshot {
  // Build markets snapshot with notifiedOdds baseline:
  // - If renders is provided and an outcome is "changed" (will be notified),
  //   reset its baseline to the current odds.
  // - Otherwise preserve the prev baseline (or default to current odds).
  const prevMarkets = prev?.markets ?? {};
  const renderMap = new Map((renders ?? []).map((r) => [r.template, r]));
  const markets: MarketsSnapshot = {};
  for (const m of fixture.markets) {
    const oldLine = prevMarkets[m.template];
    const oldByName = new Map((oldLine?.outcomes ?? []).map((o) => [o.name, o]));
    const tr = renderMap.get(m.template);
    const changedNames = new Set(tr?.outcomes.filter((o) => o.changed).map((o) => o.name) ?? []);
    markets[m.template] = {
      outcomes: m.outcomes.map((o) => {
        const old = oldByName.get(o.name);
        const notifiedOdds = changedNames.has(o.name)
          ? o.odds // just notified → reset baseline
          : old?.notifiedOdds ?? old?.odds ?? o.odds; // preserve prev or default
        return { name: o.name, odds: o.odds, notifiedOdds };
      }),
    };
  }
  return {
    id: fixture.id,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    startTime: fixture.startTime,
    league: fixture.league,
    markets,
    seededAt,
    seeded,
    messageId,
    homeScore: fixture.homeScore,
    awayScore: fixture.awayScore,
    matchStatus: fixture.matchStatus,
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
    edited: 0,
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
  // Stake removes finished matches from the feed entirely (no "finished"
  // status), so this is where we detect match completion. Do a final edit
  // to show the final score + "比赛结束" and remove buttons before deleting.
  for (const [id, prev] of Object.entries(state.fixtures)) {
    if (!currentIds.has(id)) {
      if (prev.messageId !== undefined) {
        try {
          await editMessageText(config.telegramBotToken, {
            chatId: config.telegramChatId,
            messageId: prev.messageId,
            text: [
              fixtureHeaderFromSnapshot(prev),
              `🕐 ${escapeHtml(fmtStartTime(prev.startTime))}`,
              `🏁 ${prev.homeScore ?? 0}-${prev.awayScore ?? 0}  比赛结束`,
            ].join("\n"),
            parseMode: "HTML",
            disableWebPagePreview: true,
            replyMarkup: { inline_keyboard: [] },
          });
          stats.edited += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("message is not modified")) {
            stats.errors.push(`final edit ${id}: ${msg}`);
          }
        }
      }
      // Auto-cleanup: delete odds-change notification messages.
      const notifyIds = state.notifyMessages[id];
      if (notifyIds && notifyIds.length > 0) {
        await deleteNotifyMessages(config, notifyIds);
        delete state.notifyMessages[id];
      }
      delete state.fixtures[id];
      stats.finished += 1;
    }
  }

  const cycleNow = new Date();

  for (const fixture of fixtures) {
    if (isFinished(fixture)) {
      const prev = state.fixtures[fixture.id];
      if (prev) {
        // Final edit: show final score + "比赛结束", remove buttons.
        if (prev.messageId !== undefined) {
          try {
            await editMessageText(config.telegramBotToken, {
              chatId: config.telegramChatId,
              messageId: prev.messageId,
              text: renderMessageText(fixture),
              parseMode: "HTML",
              disableWebPagePreview: true,
              replyMarkup: { inline_keyboard: [] },
            });
            stats.edited += 1;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("message is not modified")) {
              stats.errors.push(`final edit ${fixture.id}: ${msg}`);
            }
          }
        }
        // Auto-cleanup: delete odds-change notification messages.
        const notifyIds = state.notifyMessages[fixture.id];
        if (notifyIds && notifyIds.length > 0) {
          await deleteNotifyMessages(config, notifyIds);
          delete state.notifyMessages[fixture.id];
        }
        delete state.fixtures[fixture.id];
        stats.finished += 1;
      }
      continue;
    }

    if (fixture.markets.length === 0) continue;

    // Live matches are now included in the watch list — they get edited
    // just like pre-match fixtures, so the user sees live odds updates.
    const live = isLive(fixture);
    if (live) stats.live += 1;

    // Live matches are always in-window — their startTime is in the past
    // but they're actively playing, so we must keep editing.
    const inWindow = live || inWatchWindow(fixture.startTime, cycleNow);
    const prev = state.fixtures[fixture.id];

    // Outside the watch window: silently (re)write the snapshot so future
    // diffs have a baseline, but never seed or edit. Preserve seeded flag
    // and messageId so we don't re-seed when the fixture re-enters.
    if (!inWindow) {
      state.fixtures[fixture.id] = toSnapshot(
        fixture,
        prev?.seededAt ?? nowIso(),
        prev?.seeded ?? false,
        prev?.messageId,
        prev?.lastNotifiedAt,
        prev,
      );
      continue;
    }

    stats.watched += 1;

    const renders = buildTemplateRenders(fixture, prev, config.oddsChangeThreshold);

    // First in-window sighting without a prior seed: push the baseline
    // message and store its message_id for future edits.
    if (!prev || !prev.seeded) {
      try {
        const msgId = await sendSeedMessage(config, fixture, renders);
        state.fixtures[fixture.id] = toSnapshot(fixture, nowIso(), true, msgId, undefined, prev, renders);
        stats.seeded += 1;
      } catch (err) {
        state.fixtures[fixture.id] = toSnapshot(fixture, prev?.seededAt ?? nowIso(), false, undefined, undefined, prev);
        stats.errors.push(`seed notify ${fixture.id}: ${String(err)}`);
      }
      continue;
    }

    // Already seeded: edit the existing message if anything changed.
    if (!hasAnyChange(fixture, renders, prev)) {
      // No change — still update the snapshot to keep odds fresh.
      state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, prev.messageId, prev.lastNotifiedAt, prev);
      continue;
    }

    if (prev.messageId !== undefined) {
      try {
        await editFixtureMessage(config, prev.messageId, fixture, renders);
        stats.edited += 1;
        state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, prev.messageId, nowIso(), prev, renders);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "message is not modified" — content unchanged, not a real error.
        if (msg.includes("message is not modified")) {
          state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, prev.messageId, prev.lastNotifiedAt, prev);
        } else {
          stats.errors.push(`edit ${fixture.id}: ${msg}`);
          // If edit fails (e.g. message too old / deleted), fall back to a
          // new seed message and store the new message_id.
          try {
            const msgId = await sendSeedMessage(config, fixture, renders);
            state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, msgId, nowIso(), prev, renders);
            stats.edited += 1;
          } catch (seedErr) {
            stats.errors.push(`re-seed ${fixture.id}: ${String(seedErr)}`);
            state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, prev.messageId, prev.lastNotifiedAt, prev);
          }
        }
      }

      // After editing the board, send odds-change notifications for
      // templates that have crossed outcomes. Lineup changes (盘口调整)
      // are silent — only the board updates, no notification.
      for (const tr of renders) {
        const changed = tr.outcomes
          .filter((o) => o.changed && o.oldOdds !== undefined)
          .map((o) => ({ name: o.name, oldOdds: o.oldOdds!, newOdds: o.odds }));
        if (changed.length === 0) continue;
        try {
          const notifyMsgId = await notifyOddsChange(config, fixture, tr.template, changed);
          // Track in the separate notifyMessages map — survives toSnapshot rebuilds.
          const ids = state.notifyMessages[fixture.id] ?? [];
          ids.push(notifyMsgId);
          state.notifyMessages[fixture.id] = ids;
          stats.notified += 1;
        } catch (err) {
          stats.errors.push(`odds notify ${fixture.id}/${tr.template}: ${String(err)}`);
        }
      }
    } else {
      // Seeded but no messageId (shouldn't happen, but handle gracefully):
      // send a fresh seed message.
      try {
        const msgId = await sendSeedMessage(config, fixture, renders);
        state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, msgId, nowIso(), prev, renders);
        stats.seeded += 1;
      } catch (err) {
        stats.errors.push(`re-seed ${fixture.id}: ${String(err)}`);
        state.fixtures[fixture.id] = toSnapshot(fixture, prev.seededAt, true, prev.messageId, prev.lastNotifiedAt, prev);
      }
    }
  }

  await store.save(state).catch((e) => stats.errors.push(`state save: ${String(e)}`));
  return stats;
}
