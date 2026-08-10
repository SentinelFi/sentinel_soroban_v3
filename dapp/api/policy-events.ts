import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "./_lib/governance/db.js";
import { allowRequest, clientIp } from "./_lib/rate_limit.js";

/**
 * POST /api/policy-events — { flight_id, date, buyer? } (date = UTC-midnight
 * unix seconds, the on-chain bucket key).
 *
 * Display-only read over the chain-event mirror (`policies` / `settlements`,
 * written by the hourly ingest) so the policy detail page can link the
 * purchase and settlement transactions on a block explorer. Same posture as
 * flight-schedules: strictly DB-optional and fail-open — no DB, no table, or
 * no matching row just means null and the UI renders the step without a tx
 * link. The purchase lookup needs `buyer` and only matches rows the ingest
 * stored WITH a date (pre-migration rows never match — better no link than
 * the wrong flight's link).
 */

interface EventsQuery {
  flight_id: string;
  date: number;
  buyer: string | null;
}

function parseQuery(body: unknown): EventsQuery | null {
  const { flight_id, date, buyer } = (body ?? {}) as {
    flight_id?: unknown;
    date?: unknown;
    buyer?: unknown;
  };
  const dateNum = Number(date);
  if (
    typeof flight_id !== "string" ||
    !/^[A-Z0-9]{2,10}$/.test(flight_id) ||
    !Number.isInteger(dateNum) ||
    dateNum <= 0 ||
    dateNum % 86_400 !== 0
  ) {
    return null;
  }
  if (buyer !== undefined && buyer !== null) {
    if (typeof buyer !== "string" || !/^G[A-Z2-7]{55}$/.test(buyer)) return null;
  }
  return { flight_id, date: dateNum, buyer: typeof buyer === "string" ? buyer : null };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!(await allowRequest("policy-events", clientIp(req), 30))) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "rate limit exceeded — retry in a minute" });
    return;
  }
  const q = parseQuery(req.body);
  if (!q) {
    res.status(400).json({
      error:
        "expected { flight_id: string, date: UTC-midnight unix seconds, buyer?: G... address }",
    });
    return;
  }
  if (!process.env.GOVERNANCE_DB_URL) {
    res.status(200).json({ bought: null, settled: null });
    return;
  }
  try {
    const sql = getDb();
    const [boughtRows, settledRows] = await Promise.all([
      q.buyer
        ? (sql`
            select tx_hash, premium_units, bought_at
            from policies
            where flight_id = ${q.flight_id} and date = ${q.date} and buyer = ${q.buyer}
            order by ledger asc
            limit 1
          ` as unknown as Promise<
            Array<{ tx_hash: string; premium_units: string | null; bought_at: string }>
          >)
        : Promise.resolve([]),
      sql`
        select tx_hash, outcome, settled_at
        from settlements
        where flight_id = ${q.flight_id} and date = ${q.date}
        limit 1
      ` as unknown as Promise<
        Array<{ tx_hash: string | null; outcome: string; settled_at: string }>
      >,
    ]);
    const bought = boughtRows[0]
      ? {
          tx_hash: boughtRows[0].tx_hash,
          premium_units: boughtRows[0].premium_units,
          bought_at: boughtRows[0].bought_at,
        }
      : null;
    const settled = settledRows[0]
      ? {
          tx_hash: settledRows[0].tx_hash,
          outcome: settledRows[0].outcome,
          settled_at: settledRows[0].settled_at,
        }
      : null;
    res.status(200).json({ bought, settled });
  } catch (err) {
    // Missing table / DB blip — tx links are display garnish, fail open.
    console.warn(`[policy-events] read failed (ignored): ${err}`);
    res.status(200).json({ bought: null, settled: null });
  }
}
