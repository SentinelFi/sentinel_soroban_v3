import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { getDb } from "../_lib/governance/db.js";
import { ensureVaultHistoryTable } from "../_lib/governance/vault_history.js";
import { ensureExposureHistoryTable } from "../_lib/governance/exposure_history.js";
import {
  paidSettlementForPolicy,
  resolvedPayoff,
  routesForPolicy,
} from "../_lib/governance/payouts.js";

/**
 * Admin API — the TRENDS feed: every money metric as a time series, all
 * from DB mirrors (zero RPC reads, so it is cheap enough to poll).
 *
 *  - vault      vault_history (queue_maintainer, ~15min cadence) hourly-
 *               downsampled: TVL, free/locked split, share price
 *  - exposure   exposure_history (gov_exposure, hourly): open policy
 *               book, total liability vs capacity, worst bucket fraction
 *  - premiums   policies mirror bucketed per UTC day: count + units sold
 *  - payouts    settlements×policies per UTC day: what the vault paid
 *
 * The premium/payout join prefers the exact (flight_id, date) match and
 * falls back to the 4-day bought_at window for policy rows ingested
 * before the `date` column existed — same heuristic the Security board
 * documents. Which outcomes pay, and what a paid policy is worth, come
 * from governance/payouts.ts (the mirror stores the on-chain outcome
 * name and never records a per-policy payoff — see there).
 *
 * `totals.loss_ratio` is a CALENDAR loss ratio: payouts settled in the
 * window over premiums sold in the window. The cohorts differ (a policy
 * sold last week can pay out this week) — fine for trend-watching, not
 * an actuarial per-cohort figure.
 *
 * GET → { hours, vault, exposure, premiums, payouts, totals, as_of }
 *       ?hours=336 (default 14 days; clamped to [24, 720])
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!process.env.GOVERNANCE_DB_URL) {
    res.status(503).json({ error: "governance DB not configured — trends need the history mirrors" });
    return;
  }

  const hours = Math.min(720, Math.max(24, Number(req.query.hours) || 336));

  try {
    const sql = getDb();
    // The mirrors self-create on first write — a fresh deployment may not
    // have them yet, and an empty series must not 500.
    await ensureVaultHistoryTable(sql);
    await ensureExposureHistoryTable(sql);

    const [vault, exposure, premiums, payouts] = await Promise.all([
      sql`
        select ts::text, total_assets::text, free_capital::text,
               locked_capital::text, share_price::text
        from (
          select distinct on (date_trunc('hour', ts))
                 ts, total_assets, free_capital, locked_capital, share_price
          from vault_history
          where ts > now() - make_interval(hours => ${hours})
          order by date_trunc('hour', ts), ts desc
        ) hourly
        order by ts asc
      ` as unknown as Promise<
        Array<{
          ts: string;
          total_assets: string;
          free_capital: string;
          locked_capital: string;
          share_price: string;
        }>
      >,
      sql`
        select ts::text, total_liability_units::text, total_managed_units::text,
               open_policies, insured_flights, worst_route_fraction, worst_airport_fraction
        from (
          select distinct on (date_trunc('hour', ts))
                 ts, total_liability_units, total_managed_units,
                 open_policies, insured_flights, worst_route_fraction, worst_airport_fraction
          from exposure_history
          where ts > now() - make_interval(hours => ${hours})
          order by date_trunc('hour', ts), ts desc
        ) hourly
        order by ts asc
      ` as unknown as Promise<
        Array<{
          ts: string;
          total_liability_units: string;
          total_managed_units: string;
          open_policies: number;
          insured_flights: number;
          worst_route_fraction: number;
          worst_airport_fraction: number;
        }>
      >,
      sql`
        select date_trunc('day', bought_at)::text as day,
               count(*)::int as policies,
               coalesce(sum(premium_units), 0)::text as premium_units
        from policies
        where bought_at > now() - make_interval(hours => ${hours})
        group by 1
        order by 1 asc
      ` as unknown as Promise<Array<{ day: string; policies: number; premium_units: string }>>,
      sql`
        select date_trunc('day', w.settled_at)::text as day,
               count(distinct (w.flight_id, w.date))::int as settled_flights,
               count(*)::int as policies_paid,
               coalesce(sum(${resolvedPayoff(sql)}), 0)::text as payout_units
        from policies p
        ${paidSettlementForPolicy(sql)}
        ${routesForPolicy(sql)}
        where w.flight_id is not null
          and w.settled_at > now() - make_interval(hours => ${hours})
        group by 1
        order by 1 asc
      ` as unknown as Promise<
        Array<{ day: string; settled_flights: number; policies_paid: number; payout_units: string }>
      >,
    ]);

    const premiumUnits = premiums.reduce((s, r) => s + BigInt(r.premium_units), 0n);
    const payoutUnits = payouts.reduce((s, r) => s + BigInt(r.payout_units), 0n);
    const totals = {
      policies_bought: premiums.reduce((s, r) => s + r.policies, 0),
      premium_units: premiumUnits.toString(),
      policies_paid: payouts.reduce((s, r) => s + r.policies_paid, 0),
      payout_units: payoutUnits.toString(),
      loss_ratio: premiumUnits > 0n ? Number((payoutUnits * 10_000n) / premiumUnits) / 10_000 : null,
    };

    res.status(200).json({
      hours,
      vault,
      exposure,
      premiums,
      payouts,
      totals,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
