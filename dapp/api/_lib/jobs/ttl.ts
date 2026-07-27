import { SorobanClient } from "../soroban_client";
import { getDb } from "../governance/db";
import { parseFlightStatus } from "../status";
import type { Config, RunLogEntry, TTLResult } from "../types";

/**
 * Expired-claim sweeper: settled delayed/cancelled flights whose 60-day
 * claim window passed still hold unclaimed payoff in the pool until
 * someone calls the permissionless `sweep_expired` — which nothing
 * automated did before. Candidates come from the DURABLE `settlements`
 * mirror (RPC events expire long before claim windows do); the exact
 * expiry and unclaimed amount are read from the pool's own FlightConfig
 * (still alive — its TTL outlasts the claim window by design), so the DB
 * only supplies the candidate list. DB-OPTIONAL: no DB → no candidates →
 * skip silently (sweeping is revenue housekeeping, and the call remains
 * manually runnable by anyone).
 */
async function sweepExpiredClaims(client: SorobanClient, config: Config, results: TTLResult[]): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const sql = getDb();
    const candidates = (await sql`
      select flight_id, date from settlements
      where outcome in ('Delayed', 'Cancelled') and swept_at is null
      order by ledger asc
      limit 50
    `) as unknown as Array<{ flight_id: string; date: string | number }>;
    if (candidates.length === 0) return;

    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    for (const c of candidates) {
      const date = BigInt(c.date);
      const label = `${c.flight_id}@${date}`;
      try {
        const cfg = await client.readContract(config.flightPoolManagerId, "get_flight_config", [
          client.symbolToScVal(c.flight_id),
          client.u64ToScVal(date),
        ]);
        if (!cfg) {
          // Config archived — nothing to read; leave for the ops runbook.
          continue;
        }
        // FlightConfig.status is the pool's SettlementStatus enum
        // (SettledDelayed / SettledCancelled) — defensively require a
        // Settled* value before touching anything.
        const status = String(parseFlightStatus(cfg.status));
        if (!status.startsWith("Settled")) continue;
        const claimExpiry = BigInt(cfg.claim_expiry ?? 0);
        const unclaimed = BigInt(cfg.buyer_count ?? 0) - BigInt(cfg.claimed_count ?? 0);
        if (claimExpiry === 0n || nowSecs < claimExpiry) {
          continue; // window still open — not due yet
        }
        if (unclaimed > 0n) {
          await client.invokeContract(
            config.flightPoolManagerId,
            "sweep_expired",
            [client.symbolToScVal(c.flight_id), client.u64ToScVal(date)],
            config.ttlExtenderSecretKey
          );
          console.log(`[ttl-extender] swept expired claims for ${label} (${unclaimed} unclaimed buyer(s))`);
          results.push({ contract: `sweep_expired ${label}`, success: true });
        }
        // Fully claimed or just swept — either way, done forever.
        await sql`
          update settlements set swept_at = now()
          where flight_id = ${c.flight_id} and date = ${Number(c.date)}
        `;
      } catch (err) {
        console.warn(`[ttl-extender] sweep ${label} failed (retried next run): ${err}`);
        results.push({ contract: `sweep_expired ${label}`, success: false, error: String(err) });
      }
    }
  } catch (err) {
    console.warn(`[ttl-extender] sweep candidate query failed (skipped): ${err}`);
  }
}

/**
 * Cron #4 — TTLExtender (daily at midnight UTC)
 *
 * Two responsibilities:
 *
 * 1. Call extend_ttl() on each long-lived contract to renew its instance
 *    storage TTL. extend_ttl is a no-op safety net — no auth required, no
 *    state mutation.
 *
 * 2. Call OracleAggregator.prune_settled() to evict flights that have been
 *    in `Settled` status for at least 30 days from ActiveFlightList
 *    (Phase 6 permissionless cleanup, no auth required).
 *
 * Contract list updated from phase-2: recovery_pool is gone (folded into
 * FlightPoolManager); flight_pool_manager is the new singleton.
 *
 * Deeper key-level Persistent TTL extension (FlightConfig, FlightData,
 * Route, TravelerFlights, ClaimableBalance, BuyerWhitelisted via
 * ExtendFootprintTTLOp) is a separate executor concern (Improvement #6) —
 * not in this cron.
 */
/**
 * Key-level ExtendFootprintTTLOp over idle Persistent entries — the deep
 * TTL layer behind instance-level extend_ttl(). Targets enumerated from
 * the governance DB (DB-optional: no DB → skip; the entries remain
 * restorable via RestoreFootprintOp if they ever archive):
 * - GovernanceModule Route(flight_id, origin, dest) for every known route
 *   (a never-traded route's row gets no on-access bumps at all);
 * - Controller TravelerFlights(buyer) for every buyer in the policies
 *   mirror (dormant travelers keep their index).
 * Extends to ~120 days; already-longer TTLs no-op. Batched ≤20 keys/tx.
 */
async function extendIdlePersistentKeys(client: SorobanClient, config: Config, results: TTLResult[]): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  const EXTEND_TO_LEDGERS = 120 * 17_280; // ~120 days at ~5s ledgers
  const BATCH = 20;
  try {
    const sql = getDb();
    const routes = (await sql`select flight_id, origin, dest from routes`) as unknown as Array<{
      flight_id: string;
      origin: string;
      dest: string;
    }>;
    const buyers = (await sql`select distinct buyer from policies`) as unknown as Array<{ buyer: string }>;

    const routeKeys = routes.map((r) =>
      client.scvVec([
        client.symbolToScVal("Route"),
        client.symbolToScVal(r.flight_id),
        client.symbolToScVal(r.origin),
        client.symbolToScVal(r.dest),
      ])
    );
    const travelerKeys = buyers.map((b) =>
      client.scvVec([client.symbolToScVal("TravelerFlights"), client.addressToScVal(b.buyer)])
    );

    const jobs: Array<{ name: string; contractId: string; keys: ReturnType<typeof client.scvVec>[] }> = [
      { name: "governance Route", contractId: config.governanceId, keys: routeKeys },
      { name: "controller TravelerFlights", contractId: config.controllerId, keys: travelerKeys },
    ];
    for (const job of jobs) {
      for (let i = 0; i < job.keys.length; i += BATCH) {
        const batch = job.keys.slice(i, i + BATCH);
        try {
          await client.extendPersistentTtl(job.contractId, batch, EXTEND_TO_LEDGERS, config.ttlExtenderSecretKey);
          results.push({ contract: `extend ${job.name} [${i}..${i + batch.length - 1}]`, success: true });
        } catch (err) {
          console.warn(`[ttl-extender] key-level extend ${job.name} batch ${i} failed: ${err}`);
          results.push({ contract: `extend ${job.name} [${i}..]`, success: false, error: String(err) });
        }
      }
    }
    console.log(`[ttl-extender] key-level TTL: ${routeKeys.length} route + ${travelerKeys.length} traveler key(s) extended.`);
  } catch (err) {
    console.warn(`[ttl-extender] key-level extend skipped (DB): ${err}`);
  }
}

export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const client = new SorobanClient(config);
  const results: TTLResult[] = [];

  const contracts: { name: string; id: string }[] = [
    { name: "OracleAggregator", id: config.oracleAggregatorId },
    { name: "Controller", id: config.controllerId },
    { name: "RiskVault", id: config.riskVaultId },
    { name: "GovernanceModule", id: config.governanceId },
    { name: "FlightPoolManager", id: config.flightPoolManagerId },
  ];

  console.log("[ttl-extender] Starting TTL extension for all contracts...");

  for (const { name, id } of contracts) {
    try {
      await client.invokeContract(
        id,
        "extend_ttl",
        [],
        config.ttlExtenderSecretKey
      );
      console.log(`[ttl-extender] ${name} (${id.slice(0, 8)}...) extended TTL`);
      results.push({ contract: name, success: true });
    } catch (err) {
      console.error(`[ttl-extender] ${name} (${id.slice(0, 8)}...) FAILED: ${err}`);
      results.push({ contract: name, success: false, error: String(err) });
    }
  }

  // Phase 6 — permissionless prune of aged-settled flights from
  // OracleAggregator.ActiveFlightList. Idempotent; safe to run daily.
  //
  // Drain loop: prune_settled evicts at most MAX_PRUNE_BATCH=60 slots per
  // call from a rotating cursor over the WHOLE active set (live + retained),
  // so one call/day can fall behind after a backlog spike. Loop while the
  // active count keeps dropping (bounded), so each daily run fully clears
  // whatever has aged past the 7-day retention.
  try {
    const readCount = async (): Promise<number> =>
      Number((await client.readContract(config.oracleAggregatorId, "get_active_flight_count")) ?? 0);

    let count = await readCount();
    let passes = 0;
    const maxPasses = Math.min(10, Math.ceil(count / 60) + 1);
    while (passes < maxPasses) {
      passes++;
      await client.invokeContract(
        config.oracleAggregatorId,
        "prune_settled",
        [],
        config.ttlExtenderSecretKey
      );
      const next = await readCount();
      if (next >= count) break; // nothing (more) aged out — done
      count = next;
    }
    console.log(`[ttl-extender] OracleAggregator.prune_settled() done (${passes} pass(es), ${count} still listed)`);
    results.push({ contract: "OracleAggregator.prune_settled", success: true });
  } catch (err) {
    console.error(`[ttl-extender] prune_settled FAILED: ${err}`);
    results.push({
      contract: "OracleAggregator.prune_settled",
      success: false,
      error: String(err),
    });
  }

  // Expired-claim sweep (permissionless; candidates from the settlements
  // mirror, amounts verified on-chain).
  await sweepExpiredClaims(client, config, results);

  // Key-level Persistent TTL extension (the long-planned deep layer):
  // idle entries get no on-access bumps — extend them explicitly.
  await extendIdlePersistentKeys(client, config, results);

  console.log("[ttl-extender] Done.");
  const allSuccess = results.every((r) => r.success);
  return {
    timestamp: new Date().toISOString(),
    job: "ttl_extender",
    duration_ms: Date.now() - start,
    success: allSuccess,
    error: allSuccess ? null : "Some contracts failed TTL extension",
    results,
  };
}
