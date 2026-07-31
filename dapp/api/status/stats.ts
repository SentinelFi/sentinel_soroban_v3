import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../_lib/config";
import { getDb } from "../_lib/governance/db";
import { publicError } from "../_lib/public_error";
import { SorobanClient } from "../_lib/soroban_client";
import { FlightStatus } from "../_lib/types";

/**
 * GET /api/status/stats — PUBLIC, sanitized protocol stats for the Markets
 * stats strip. Chain (`Controller.get_stats`) always answers; the DB
 * (`settlements`, mirrored by the event-ingest cron) breaks the payouts
 * down by outcome — DB-optional: a DB outage degrades those three fields
 * to `null` rather than failing the request (chain-only fallback).
 *
 * flights_insured  — TotalPoliciesSold (chain)
 * total_paid_out   — TotalPayoutsDistributed (chain) — gross claimable,
 *                     i.e. the FULL payoff per policy, premium portion
 *                     included (see controller/src/settle.rs: total_payoff
 *                     = payoff * buyer_count, credited for BOTH Delayed and
 *                     Cancelled outcomes, not just Delayed)
 * insurances_paid  — DB: settlements count, Delayed + Cancelled (both pay)
 * delayed_count    — DB: settlements count, ToBeSettledDelayed
 * cancelled_count  — DB: settlements count, ToBeSettledCancelled
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const config = loadConfig();
    const client = new SorobanClient(config);
    const stats = (await client.readContract(config.controllerId, "get_stats")) as
      | [bigint, bigint, bigint]
      | undefined;
    const [sold, , distributed] = stats ?? [0n, 0n, 0n];

    let delayed_count: number | null = null;
    let cancelled_count: number | null = null;
    let insurances_paid: number | null = null;
    let db_available = false;

    if (process.env.GOVERNANCE_DB_URL) {
      try {
        const sql = getDb();
        const rows = (await sql`
          select outcome, count(*)::int as count from settlements
          where outcome in (${FlightStatus.ToBeSettledDelayed}, ${FlightStatus.ToBeSettledCancelled})
          group by outcome
        `) as unknown as Array<{ outcome: string; count: number }>;
        const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r.count]));
        delayed_count = byOutcome[FlightStatus.ToBeSettledDelayed] ?? 0;
        cancelled_count = byOutcome[FlightStatus.ToBeSettledCancelled] ?? 0;
        insurances_paid = delayed_count + cancelled_count;
        db_available = true;
      } catch {
        // DB hiccup — chain-only fields above still answer.
      }
    }

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      flights_insured: Number(sold),
      insurances_paid,
      delayed_count,
      cancelled_count,
      total_paid_out: distributed.toString(),
      db_available,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: publicError("status-stats", err) });
  }
}
