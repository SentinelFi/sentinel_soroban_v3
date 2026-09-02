import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "./_lib/governance/db.js";
import {
  paidSettlementForPolicy,
  resolvedPayoff,
  routesForPolicy,
} from "./_lib/governance/payouts.js";

/**
 * GET /api/leaderboard — the Seatbelters board: travelers ranked by net
 * P&L (payouts collected minus premiums paid) from the chain-event mirror
 * (`policies` + `settlements`, written by event_ingest.ts).
 *
 * GET /api/leaderboard?buyer=G… — one traveler's own row and seat in
 * every window, whether or not they made the top-N cut. Same query, one
 * extra window function; cached privately (per address) rather than at
 * the CDN edge.
 *
 * A "win" = a covered flight that settled with a paying outcome. Which
 * outcomes pay, how a settlement pairs with a policy (exact date, with
 * a four-day fallback for rows ingested before the mirror stored the
 * date), and what a win is worth all come from governance/payouts.ts —
 * shared with the admin boards so the figures agree.
 *
 * All four time windows ship in ONE cached response so the UI's filter
 * flips instantly with no extra requests. Rankings only see what the
 * mirror holds — events before the ingest first ran (or inside a logged
 * retention gap) are not counted; acceptable for a fun board, documented
 * here so nobody mistakes it for accounting.
 *
 * Degrades to empty boards (`db: false`) when no DB is configured or the
 * query fails — the page renders its empty state, never a 500.
 */
export const config = { maxDuration: 15 };

const TOP_N = 20;
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export interface LeaderRow {
  buyer: string;
  policies: number;
  /** Premiums paid in the window, USDC base units. */
  premium_units: string;
  /** Covered flights that settled Delayed or Cancelled. */
  wins: number;
  /** Payouts credited for those wins, USDC base units. */
  payout_units: string;
  /** payout_units − premium_units — the ranking key. */
  pnl_units: string;
}

/** A single traveler's row plus their 1-based position on the board. */
export interface SeatRow extends LeaderRow {
  seat: number;
}

const WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type LeaderWindow = (typeof WINDOWS)[number];

const WINDOW_HOURS: Record<LeaderWindow, number | null> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
  all: null,
};

type Sql = ReturnType<typeof getDb>;

/**
 * Per-traveler totals for one window — the CTEs both the board and the
 * single-seat lookup are built on, so they can never rank differently.
 * `scored` is one row per policy with its resolved payout; `totals`
 * folds that per buyer.
 */
function travelerTotals(sql: Sql, hours: number | null) {
  return sql`
    scored as (
      select p.buyer,
             p.premium_units,
             case when w.flight_id is null then 0 else ${resolvedPayoff(sql)} end as payout_units,
             (w.flight_id is not null) as won
      from policies p
      ${routesForPolicy(sql)}
      ${paidSettlementForPolicy(sql)}
      where ${hours === null ? sql`true` : sql`p.bought_at > now() - make_interval(hours => ${hours})`}
    ),
    totals as (
      select buyer,
             count(*)::int as policies,
             coalesce(sum(premium_units), 0) as premium_units,
             count(*) filter (where won)::int as wins,
             coalesce(sum(payout_units), 0) as payout_units
      from scored
      group by buyer
    )`;
}

/** The board's order: P&L, then what was staked, then breadth, then address. */
function boardOrder(sql: Sql) {
  return sql`(payout_units - premium_units) desc, premium_units desc, policies desc, buyer`;
}

async function topTravelers(hours: number | null): Promise<LeaderRow[]> {
  const sql = getDb();
  const rows = (await sql`
    with ${travelerTotals(sql, hours)}
    select buyer,
           policies,
           premium_units::text as premium_units,
           wins,
           payout_units::text as payout_units,
           (payout_units - premium_units)::text as pnl_units
    from totals
    order by ${boardOrder(sql)}
    limit ${TOP_N}
  `) as unknown as LeaderRow[];
  return rows;
}

/** One traveler's row and seat for a window; null when they bought nothing in it. */
async function travelerSeat(hours: number | null, buyer: string): Promise<SeatRow | null> {
  const sql = getDb();
  const rows = (await sql`
    with ${travelerTotals(sql, hours)},
    ranked as (
      select *, row_number() over (order by ${boardOrder(sql)})::int as seat
      from totals
    )
    select buyer,
           policies,
           premium_units::text as premium_units,
           wins,
           payout_units::text as payout_units,
           (payout_units - premium_units)::text as pnl_units,
           seat
    from ranked
    where buyer = ${buyer}
  `) as unknown as SeatRow[];
  return rows[0] ?? null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const buyerParam = typeof req.query.buyer === "string" ? req.query.buyer : undefined;
  if (buyerParam !== undefined) {
    if (!ADDRESS_RE.test(buyerParam)) {
      res.status(400).json({ error: "buyer must be a Stellar public key (G…)" });
      return;
    }
    await serveSeat(buyerParam, res);
    return;
  }

  const empty = Object.fromEntries(WINDOWS.map((w) => [w, [] as LeaderRow[]]));
  let windows = empty;
  let db = false;

  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const results = await Promise.all(WINDOWS.map((w) => topTravelers(WINDOW_HOURS[w])));
      windows = Object.fromEntries(WINDOWS.map((w, i) => [w, results[i] ?? []]));
      db = true;
    } catch (err) {
      console.warn(`[leaderboard] query failed (${err}) — serving empty boards.`);
      windows = empty;
    }
  }

  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({ as_of: new Date().toISOString(), db, top_n: TOP_N, windows });
}

/** The ?buyer= branch: that traveler's seat in every window, or nulls. */
async function serveSeat(buyer: string, res: VercelResponse): Promise<void> {
  const empty = Object.fromEntries(WINDOWS.map((w) => [w, null as SeatRow | null]));
  let windows = empty;
  let db = false;

  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const results = await Promise.all(WINDOWS.map((w) => travelerSeat(WINDOW_HOURS[w], buyer)));
      windows = Object.fromEntries(WINDOWS.map((w, i) => [w, results[i] ?? null]));
      db = true;
    } catch (err) {
      console.warn(`[leaderboard] seat query failed (${err}) — serving empty seat.`);
      windows = empty;
    }
  }

  // Per-address answer: cache in the browser only, never at the edge.
  res.setHeader("Cache-Control", "private, max-age=60");
  res.status(200).json({ as_of: new Date().toISOString(), db, buyer, windows });
}
