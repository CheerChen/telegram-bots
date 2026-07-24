import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MarketLine } from "./stake.ts";

// Per-template odds snapshot. Keyed by template name so we can diff each
// market line (胜平负 / 亚洲让分盘 / 合计) independently.
// notifiedOdds is the odds baseline at the last notification (or seed);
// it lets us detect cumulative drift across multiple cycles even when each
// individual step stays below the threshold.
export type MarketsSnapshot = Record<string, { outcomes: { name: string; odds: number; notifiedOdds?: number }[] }>;

export interface FixtureSnapshot {
  id: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startTime: string | null;
  league: string | null;
  markets: MarketsSnapshot;
  seededAt: string;
  seeded: boolean;
  // Telegram message_id of the seed message — used for editMessage updates
  // so each fixture stays as a single message in the topic.
  messageId?: number;
  // Live match state — tracked so score/status changes trigger an edit.
  homeScore?: number | null;
  awayScore?: number | null;
  matchStatus?: string | null;
  lastNotifiedAt?: string;
}

export interface StakeOddsState {
  fixtures: Record<string, FixtureSnapshot>;
  // Notification message IDs per fixture, tracked separately from the
  // board snapshot so they survive toSnapshot rebuilds. Cleared on finish.
  notifyMessages: Record<string, number[]>;
  lastCredentialAlertAt?: string;
}

const EMPTY_STATE: StakeOddsState = { fixtures: {}, notifyMessages: {} };

export function marketsToSnapshot(markets: MarketLine[]): MarketsSnapshot {
  const out: MarketsSnapshot = {};
  for (const m of markets) {
    out[m.template] = {
      outcomes: m.outcomes.map((o) => ({ name: o.name, odds: o.odds })),
    };
  }
  return out;
}

export class StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StakeOddsState> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<StakeOddsState>;
      const fixturesRaw = parsed.fixtures;
      const fixtures: Record<string, FixtureSnapshot> = {};
      if (fixturesRaw && typeof fixturesRaw === "object") {
        for (const [id, snap] of Object.entries(fixturesRaw)) {
          if (!snap || typeof snap !== "object") continue;
          fixtures[id] = {
            id: snap.id ?? id,
            homeTeam: snap.homeTeam ?? null,
            awayTeam: snap.awayTeam ?? null,
            startTime: snap.startTime ?? null,
            league: snap.league ?? null,
            markets: snap.markets ?? {},
            seededAt: snap.seededAt ?? "",
            seeded: snap.seeded === true,
            messageId: typeof snap.messageId === "number" ? snap.messageId : undefined,
            homeScore: typeof snap.homeScore === "number" ? snap.homeScore : null,
            awayScore: typeof snap.awayScore === "number" ? snap.awayScore : null,
            matchStatus: typeof snap.matchStatus === "string" ? snap.matchStatus : null,
            lastNotifiedAt: typeof snap.lastNotifiedAt === "string" ? snap.lastNotifiedAt : undefined,
          };
        }
      }
      // Load notifyMessages map (fixtureId → messageIds).
      const notifyMessagesRaw = parsed.notifyMessages;
      const notifyMessages: Record<string, number[]> = {};
      if (notifyMessagesRaw && typeof notifyMessagesRaw === "object") {
        for (const [id, ids] of Object.entries(notifyMessagesRaw)) {
          if (Array.isArray(ids)) {
            notifyMessages[id] = ids.filter((n) => typeof n === "number");
          }
        }
      }
      return {
        fixtures,
        notifyMessages,
        lastCredentialAlertAt:
          typeof parsed.lastCredentialAlertAt === "string" ? parsed.lastCredentialAlertAt : undefined,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE };
      throw err;
    }
  }

  async save(state: StakeOddsState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.path);
  }
}
