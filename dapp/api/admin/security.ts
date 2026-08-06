import type { VercelRequest, VercelResponse } from "@vercel/node";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { getDb } from "../_lib/governance/db.js";
import { loadPublicConfig } from "../_lib/config.js";
import { ensureVaultHistoryTable } from "../_lib/governance/vault_history.js";
import { mapLimited, simulateRead } from "../_lib/sim_read.js";

/**
 * Admin API — the fraud-signals board.
 *
 * Nothing here is proof of fraud; every section is a PATTERN that
 * deserves a human look before it becomes a payout problem:
 *
 *   win_outliers      buyers whose delayed/cancelled hit-rate is far above
 *                     the book's baseline (info advantage? oracle leak?);
 *   swarm_flights     one flight-day drawing many distinct buyers (sybil
 *                     ring bypassing the one-policy-per-traveler cap, or
 *                     a leak that one flight is a sure thing);
 *   ledger_batches    several policies landing in the SAME ledger
 *                     (coordinated submission — one operator, many keys);
 *   manual_triggers   cron endpoints invoked outside the schedule
 *                     (someone with CRON_SECRET running jobs by hand);
 *   whitelist_changes buyer-gate mutations (who was let in, by whom);
 *   actor_summary     every governance actor's 7-day action/failure count
 *                     (an unexpected actor or failure spike shows here).
 *
 * The win-rate join is a HEURISTIC: the policies mirror has no flight
 * date, so a policy is counted as "won" when its flight settled
 * Delayed/Cancelled within 4 days after purchase. Good enough to rank
 * outliers; not a court record. All figures come from the durable DB
 * mirrors — RPC's ~7-day event retention never limits this board.
 *
 * GET → { baseline, win_outliers, swarm_flights, ledger_batches,
 *         manual_triggers, whitelist_changes, actor_summary, as_of }
 */

export const config = { maxDuration: 60 };

const OUTLIER_MIN_POLICIES = 3;
const OUTLIER_MIN_RATE = 0.75;
const SWARM_MIN_BUYERS = 5;
const BATCH_MIN_POLICIES = 3;
/** term-change → purchase correlation window */
const TERM_BUY_WINDOW_MIN = 30;
/** share-price move within 24h that trips the motion alarm */
const PRICE_MOVE_ALERT = 0.05;
/** coverage-percentage-points drop within 24h that trips the alarm */
const COVERAGE_DROP_ALERT = 20;
/** single holder owning more than this fraction of shares */
const DOMINANCE_PCT = 0.33;
/** single queued request larger than this fraction of TVL / supply */
const FLOW_PCT = 0.2;
const PROBE_CAP = 100;
const PROBE_CONCURRENCY = 6;

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
    res.status(503).json({ error: "governance DB not configured — fraud signals need the event mirror" });
    return;
  }

  try {
    const sql = getDb();

    // Per-buyer win rates via the time-window join described above.
    const buyerRows = (await sql`
      with joined as (
        select p.buyer,
               p.bought_at,
               (s.flight_id is not null)::int as won
        from policies p
        left join settlements s
          on s.flight_id = p.flight_id
         and s.outcome in ('Delayed', 'Cancelled')
         and s.settled_at >= p.bought_at
         and s.settled_at <  p.bought_at + interval '4 days'
      )
      select buyer,
             count(*)::int as policies,
             sum(won)::int as wins,
             max(bought_at)::text as last_at
      from joined
      group by buyer
    `) as unknown as Array<{ buyer: string; policies: number; wins: number; last_at: string }>;

    const totalPolicies = buyerRows.reduce((s, b) => s + b.policies, 0);
    const totalWins = buyerRows.reduce((s, b) => s + b.wins, 0);
    const winOutliers = buyerRows
      .map((b) => ({ ...b, win_rate: b.policies > 0 ? b.wins / b.policies : 0 }))
      .filter((b) => b.policies >= OUTLIER_MIN_POLICIES && b.win_rate >= OUTLIER_MIN_RATE)
      .sort((a, b) => b.win_rate - a.win_rate || b.policies - a.policies)
      .slice(0, 20);

    const swarmFlights = (await sql`
      select flight_id,
             date_trunc('day', bought_at)::text as day,
             count(distinct buyer)::int as buyers,
             count(*)::int as policies,
             coalesce(sum(premium_units), 0)::text as premium_units,
             coalesce(sum(payoff_units), 0)::text as payoff_units
      from policies
      group by flight_id, date_trunc('day', bought_at)
      having count(distinct buyer) >= ${SWARM_MIN_BUYERS}
      order by buyers desc
      limit 20
    `) as unknown as Array<{
      flight_id: string;
      day: string;
      buyers: number;
      policies: number;
      premium_units: string;
      payoff_units: string;
    }>;

    const ledgerBatches = (await sql`
      select ledger,
             count(*)::int as policies,
             count(distinct buyer)::int as buyers,
             array_agg(distinct flight_id) as flights
      from policies
      group by ledger
      having count(*) >= ${BATCH_MIN_POLICIES}
      order by ledger desc
      limit 20
    `) as unknown as Array<{ ledger: number; policies: number; buyers: number; flights: string[] }>;

    const manualTriggers = (await sql`
      select job, trigger, ran_at::text, success
      from cron_runs
      where trigger <> 'schedule' and ran_at > now() - interval '7 days'
      order by ran_at desc
      limit 50
    `) as unknown as Array<{ job: string; trigger: string; ran_at: string; success: boolean }>;

    const whitelistChanges = (await sql`
      select actor, action, before, ts::text, success
      from actions_log
      where action in ('add_whitelisted_buyer', 'remove_whitelisted_buyer')
        and ts > now() - interval '30 days'
      order by ts desc
      limit 30
    `) as unknown as Array<{
      actor: string;
      action: string;
      before: { addr?: string } | null;
      ts: string;
      success: boolean;
    }>;

    const actorSummary = (await sql`
      select actor,
             count(*)::int as actions,
             count(*) filter (where not success)::int as failures,
             max(ts)::text as last_at
      from actions_log
      where ts > now() - interval '7 days'
      group by actor
      order by actions desc
      limit 30
    `) as unknown as Array<{ actor: string; actions: number; failures: number; last_at: string }>;

    // ── term-change → buy correlation ──────────────────────────────
    // Purchases on a route within minutes of a governance term/whitelist
    // action on the SAME route — the classic insider-on-governance shape.
    const termBuys = (await sql`
      select a.ts::text as action_ts,
             a.action,
             a.actor,
             a.flight_id,
             p.buyer,
             p.bought_at::text,
             extract(epoch from (p.bought_at - a.ts))::int as delay_secs,
             coalesce(p.payoff_units, 0)::text as payoff_units
      from actions_log a
      join policies p
        on p.flight_id = a.flight_id
       and p.bought_at >= a.ts
       and p.bought_at < a.ts + make_interval(mins => ${TERM_BUY_WINDOW_MIN})
      where a.action in ('update_route_terms', 'whitelist_route', 'enable_route')
        and a.success
      order by a.ts desc
      limit 30
    `) as unknown as Array<{
      action_ts: string;
      action: string;
      actor: string;
      flight_id: string;
      buyer: string;
      bought_at: string;
      delay_secs: number;
      payoff_units: string;
    }>;

    // ── vault motion + supply conservation (vault_history mirror) ──
    await ensureVaultHistoryTable(sql);
    const history = (await sql`
      select ts::text, total_assets::text, free_capital::text,
             locked_capital::text, total_supply::text, share_price::text
      from vault_history
      where ts > now() - interval '48 hours'
      order by ts asc
    `) as unknown as Array<{
      ts: string;
      total_assets: string;
      locked_capital: string;
      free_capital: string;
      total_supply: string;
      share_price: string;
    }>;

    const coverageOf = (r: { total_assets: string; locked_capital: string }): number | null => {
      const locked = Number(r.locked_capital);
      return locked > 0 ? (Number(r.total_assets) / locked) * 100 : null;
    };
    const latest = history[history.length - 1] ?? null;
    const dayAgoMs = Date.now() - 24 * 3600 * 1000;
    const prev24 =
      [...history].reverse().find((r) => new Date(r.ts).getTime() <= dayAgoMs) ??
      history[0] ??
      null;
    let maxStepPct = 0;
    for (let i = 1; i < history.length; i++) {
      const a = Number(history[i - 1]!.share_price);
      const b = Number(history[i]!.share_price);
      if (a > 0) maxStepPct = Math.max(maxStepPct, Math.abs(b - a) / a);
    }
    const priceChange24 =
      latest && prev24 && Number(prev24.share_price) > 0
        ? (Number(latest.share_price) - Number(prev24.share_price)) / Number(prev24.share_price)
        : null;
    const coverageNow = latest ? coverageOf(latest) : null;
    const coverage24 = prev24 ? coverageOf(prev24) : null;
    const coverageDrop =
      coverageNow !== null && coverage24 !== null ? coverage24 - coverageNow : null;

    const supplyViolations = (await sql`
      with h as (
        select ts, total_supply,
               lag(total_supply) over (order by ts) as prev_supply,
               lag(ts) over (order by ts) as prev_ts
        from vault_history
        where ts > now() - interval '7 days'
      )
      select ts::text, prev_ts::text, total_supply::text, prev_supply::text
      from h
      where prev_supply is not null
        and total_supply <> prev_supply
        and not exists (
          select 1 from cron_runs c
          where c.job = 'queue_maintainer'
            and c.ran_at > h.prev_ts - interval '2 minutes'
            and c.ran_at <= h.ts + interval '2 minutes'
        )
      order by ts desc
      limit 20
    `) as unknown as Array<{
      ts: string;
      prev_ts: string;
      total_supply: string;
      prev_supply: string;
    }>;

    // ── vault dominance & flow anomalies (live chain reads) ────────
    const pub = loadPublicConfig();
    const server = new rpc.Server(pub.rpcUrl);
    const vaultId = pub.contractIds.riskVault;
    const read = (method: string, args?: Parameters<typeof simulateRead>[4]) =>
      simulateRead(server, pub.network, vaultId, method, args);
    const [supplyRaw, tmaRaw, depositQueue, withdrawalQueue] = await Promise.all([
      read("total_supply"),
      read("get_total_managed_assets"),
      read("get_deposit_queue"),
      read("get_withdrawal_queue"),
    ]);
    const supply = BigInt((supplyRaw as bigint | undefined) ?? 0n);
    const tma = BigInt((tmaRaw as bigint | undefined) ?? 0n);
    const deposits = (depositQueue ?? []) as Array<{ owner: string; assets: bigint }>;
    const withdrawals = (withdrawalQueue ?? []) as Array<{ owner: string; shares: bigint }>;

    const buyerCandidates = (await sql`
      select distinct buyer from policies limit ${PROBE_CAP}
    `) as unknown as Array<{ buyer: string }>;
    const candidates = [
      ...new Set([
        ...buyerCandidates.map((b) => b.buyer),
        ...deposits.map((d) => d.owner),
        ...withdrawals.map((w) => w.owner),
      ]),
    ].slice(0, PROBE_CAP);
    const holderBalances = await mapLimited(candidates, PROBE_CONCURRENCY, async (address) => {
      try {
        const shares = (await simulateRead(server, pub.network, vaultId, "balance", [
          nativeToScVal(address, { type: "address" }),
        ])) as bigint;
        return { address, shares };
      } catch {
        return { address, shares: 0n };
      }
    });
    const fractionOf = (units: bigint, total: bigint): number =>
      total > 0n ? Number((units * 1_000_000n) / total) / 1_000_000 : 0;
    const dominance = holderBalances
      .filter((h) => h.shares > 0n)
      .map((h) => ({
        address: h.address,
        shares: h.shares.toString(),
        fraction: fractionOf(h.shares, supply),
      }))
      .sort((a, b) => b.fraction - a.fraction)
      .slice(0, 5);

    const largeRequests = [
      ...deposits
        .filter((d) => tma > 0n && fractionOf(BigInt(d.assets ?? 0n), tma) >= FLOW_PCT)
        .map((d) => ({
          kind: "deposit" as const,
          owner: d.owner,
          amount_units: BigInt(d.assets ?? 0n).toString(),
          fraction: fractionOf(BigInt(d.assets ?? 0n), tma),
        })),
      ...withdrawals
        .filter((w) => supply > 0n && fractionOf(BigInt(w.shares ?? 0n), supply) >= FLOW_PCT)
        .map((w) => ({
          kind: "withdrawal" as const,
          owner: w.owner,
          amount_units: BigInt(w.shares ?? 0n).toString(),
          fraction: fractionOf(BigInt(w.shares ?? 0n), supply),
        })),
    ];
    const depositOwners = new Set(deposits.map((d) => d.owner));
    const bothQueues = [
      ...new Set(withdrawals.filter((w) => depositOwners.has(w.owner)).map((w) => w.owner)),
    ];

    res.status(200).json({
      baseline: {
        policies: totalPolicies,
        buyers: buyerRows.length,
        global_win_rate: totalPolicies > 0 ? totalWins / totalPolicies : 0,
      },
      win_outliers: winOutliers,
      swarm_flights: swarmFlights,
      ledger_batches: ledgerBatches,
      manual_triggers: manualTriggers,
      whitelist_changes: whitelistChanges.map((w) => ({
        actor: w.actor,
        action: w.action,
        addr: w.before?.addr ?? null,
        ts: w.ts,
        success: w.success,
      })),
      actor_summary: actorSummary,
      term_buys: termBuys,
      vault_motion: {
        rows_48h: history.length,
        latest_ts: latest?.ts ?? null,
        share_price_now: latest?.share_price ?? null,
        price_change_24h: priceChange24,
        max_step_pct: maxStepPct,
        coverage_now: coverageNow,
        coverage_drop_24h: coverageDrop,
      },
      supply_violations: supplyViolations,
      dominance: { top: dominance, total_supply: supply.toString() },
      flows: { large_requests: largeRequests, both_queues: bothQueues },
      thresholds: {
        outlier_min_policies: OUTLIER_MIN_POLICIES,
        outlier_min_rate: OUTLIER_MIN_RATE,
        swarm_min_buyers: SWARM_MIN_BUYERS,
        batch_min_policies: BATCH_MIN_POLICIES,
        term_buy_window_min: TERM_BUY_WINDOW_MIN,
        price_move_alert: PRICE_MOVE_ALERT,
        coverage_drop_alert: COVERAGE_DROP_ALERT,
        dominance_pct: DOMINANCE_PCT,
        flow_pct: FLOW_PCT,
      },
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
