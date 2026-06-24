import type { StakeOddsConfig } from "./config.ts";

// Trimmed SportIndex query: only the popular #1 tournament + up to 50 fixtures
// with the full threeway group (胜平负 / 亚洲让分盘 / 合计). One round-trip per cycle.
const SPORT_INDEX_QUERY = `
query SportIndex($sport: String!, $group: String!, $type: SportSearchEnum = popular) {
  slugSport(sport: $sport) {
    id
    name
    tournamentList(type: $type, limit: 1) {
      id
      name
      slug
      fixtureList(type: $type, limit: 50) {
        id
        status
        name
        data {
          __typename
          ... on SportFixtureDataMatch {
            startTime
            competitors {
              name
            }
          }
        }
        eventStatus {
          __typename
          ... on SportFixtureEventStatusData {
            homeScore
            awayScore
            matchStatus
          }
        }
        tournament {
          name
        }
        groups(groups: [$group], status: [active, suspended, deactivated]) {
          name
          templates(limit: 10, includeEmpty: true) {
            name
            markets(limit: 20) {
              name
              status
              outcomes {
                id
                name
                odds
                active
              }
            }
          }
        }
      }
    }
  }
}
`;

// One market line within a fixture. A fixture's threeway group typically has
// three of these: 胜平负 (3 outcomes), 亚洲让分盘 (2), 合计 (2) = 7 outcomes total.
export interface MarketLine {
  template: string;
  outcomes: { name: string; odds: number }[];
}

export interface Fixture {
  id: string;
  name: string;
  status: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  startTime: string | null;
  league: string | null;
  matchStatus: string | null;
  homeScore: number | null;
  awayScore: number | null;
  markets: MarketLine[];
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

interface Outcome {
  name?: string;
  odds?: number;
  active?: boolean;
}

interface Market {
  name?: string;
  status?: string;
  outcomes?: Outcome[];
}

interface Template {
  name?: string;
  markets?: Market[];
}

interface Group {
  name?: string;
  templates?: Template[];
}

interface FixtureData {
  startTime?: string;
  competitors?: { name?: string }[];
}

interface EventStatus {
  homeScore?: number;
  awayScore?: number;
  matchStatus?: string;
}

interface FixtureNode {
  id: string;
  status?: string;
  name?: string;
  data?: FixtureData;
  eventStatus?: EventStatus;
  tournament?: { name?: string };
  groups?: Group[];
}

interface TournamentNode {
  id: string;
  name?: string;
  slug?: string;
  fixtureList?: FixtureNode[];
}

interface GraphQLResponse {
  data?: { slugSport?: { tournamentList?: TournamentNode[] } };
  errors?: unknown;
}

function parseMarkets(groups: Group[] | undefined): MarketLine[] {
  const group = groups?.[0];
  const templates = group?.templates ?? [];
  const lines: MarketLine[] = [];
  for (const tp of templates) {
    if (!tp.name) continue;
    const markets = tp.markets ?? [];
    if (markets.length === 0) continue;

    // Each template may have multiple market lines (different handicap
    // values, different over/under thresholds). Pick the most balanced one:
    // the line whose active odds have the smallest spread (max - min).
    // This matches what the Stake web UI shows as the "main" line.
    let best: { outcomes: { name: string; odds: number }[]; spread: number } | null = null;
    for (const market of markets) {
      const raw = (market.outcomes ?? [])
        .filter((o) => o.active !== false && typeof o.odds === "number" && Number.isFinite(o.odds) && o.odds > 1)
        .map((o) => ({ name: o.name ?? "", odds: o.odds as number }));
      if (raw.length < 2) continue;
      const odds = raw.map((o) => o.odds);
      const spread = Math.max(...odds) - Math.min(...odds);
      if (best === null || spread < best.spread) {
        best = { outcomes: raw, spread };
      }
    }

    if (best) lines.push({ template: tp.name, outcomes: best.outcomes });
  }
  return lines;
}

function parseFixture(node: FixtureNode): Fixture {
  const data = node.data ?? {};
  const competitors = data.competitors ?? [];
  const status = node.eventStatus ?? {};
  return {
    id: node.id,
    name: node.name ?? "",
    status: node.status ?? null,
    homeTeam: competitors[0]?.name ?? null,
    awayTeam: competitors[1]?.name ?? null,
    startTime: data.startTime ?? null,
    league: node.tournament?.name ?? null,
    matchStatus: status.matchStatus ?? null,
    homeScore: status.homeScore ?? null,
    awayScore: status.awayScore ?? null,
    markets: parseMarkets(node.groups),
  };
}

function looksLikeCloudflareChallenge(text: string): boolean {
  return /cf-chl|cf-challenge|just a moment|attention required|cloudflare/i.test(text);
}

export async function fetchFixtures(config: StakeOddsConfig): Promise<{ league: string | null; fixtures: Fixture[] }> {
  const headers: Record<string, string> = {
    "User-Agent": config.userAgent,
    Accept: "*/*",
    "Accept-Language": config.acceptLanguage,
    "Content-Type": "application/json",
    Origin: "https://stake.com",
    Referer: `https://stake.com/zh/sports/${config.sportSlug}`,
    "X-Language": config.xLanguage,
    "X-Access-Token": config.accessToken,
    "X-Operation-Name": "SportIndex",
    "X-Operation-Type": "query",
  };
  const cookies: Record<string, string> = { cf_clearance: config.cfClearance };
  if (config.sessionCookie) cookies.session = config.sessionCookie;
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

  const payload = {
    query: SPORT_INDEX_QUERY,
    variables: { sport: config.sportSlug, group: config.group },
    operationName: "SportIndex",
  };

  const res = await fetch("https://stake.com/_api/graphql", {
    method: "POST",
    headers: { ...headers, Cookie: cookieHeader },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  // 401/403 → access token rejected; Cloudflare challenge page → cf_clearance stale.
  if (res.status === 401 || res.status === 403) {
    throw new CredentialError(`stake auth rejected: HTTP ${res.status}`);
  }
  const text = await res.text();
  if (res.status >= 400) {
    if (looksLikeCloudflareChallenge(text)) {
      throw new CredentialError(`stake cloudflare challenge: HTTP ${res.status}`);
    }
    throw new Error(`stake HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (looksLikeCloudflareChallenge(text)) {
    throw new CredentialError("stake cloudflare challenge in body");
  }

  let body: GraphQLResponse;
  try {
    body = JSON.parse(text) as GraphQLResponse;
  } catch {
    throw new Error(`stake: non-JSON response (len=${text.length})`);
  }
  if (body.errors) {
    // Partial errors with data present are individual fixture failures
    // (e.g. "出现未知错误 341063" on a single match) — transient server-side
    // issues, not credential problems. Proceed with whatever data was returned.
    // Only treat as a credential error when the entire data payload is missing.
    if (body.data == null) {
      throw new CredentialError(`stake graphql errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
    }
  }

  const tournament = body.data?.slugSport?.tournamentList?.[0] ?? null;
  const fixtures = (tournament?.fixtureList ?? []).map(parseFixture);
  return { league: tournament?.name ?? null, fixtures };
}
