import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "./_lib/governance/db.js";

/**
 * GET /api/leaderboard — the Seatbelters board: top premium buyers from
 * the chain-event mirror (`policies`, written by event_ingest.ts), with a
 * win count from `settlements` (a "win" = the covered flight settled
 * Delayed or Cancelled — the payout outcomes).
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

export interface LeaderRow {
  buyer: string;
  policies: number;
  premium_units: string;
  wins: number;
}

const WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type LeaderWindow = (typeof WINDOWS)[number];

const WINDOW_HOURS: Record<LeaderWindow, number | null> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
  all: null,
};

async function topBuyers(hours: number | null): Promise<LeaderRow[]> {
  const sql = getDb();
  // `settlements.date` and `policies.date` are the same UTC day bucket, so
  // the pair join attributes a settlement to every policy on that flight.
  const rows = (await sql`
    select p.buyer,
           count(*)::int as policies,
           coalesce(sum(p.premium_units), 0)::text as premium_units,
           count(s.flight_id)::int as wins
    from policies p
    left join settlements s
      on s.flight_id = p.flight_id
     and s.date = p.date
     and s.outcome in ('Delayed', 'Cancelled')
    where ${hours === null ? sql`true` : sql`p.bought_at > now() - make_interval(hours => ${hours})`}
    group by p.buyer
    order by sum(p.premium_units) desc nulls last, count(*) desc, p.buyer
    limit ${TOP_N}
  `) as unknown as LeaderRow[];
  return rows;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const empty = Object.fromEntries(WINDOWS.map((w) => [w, [] as LeaderRow[]]));
  let windows = empty;
  let db = false;

  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const results = await Promise.all(WINDOWS.map((w) => topBuyers(WINDOW_HOURS[w])));
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
