import { SorobanClient } from "../soroban_client.js";
import { getDb } from "../governance/db.js";
import { parseFlightStatus } from "../status.js";
import type { Config, FetcherAction, RunLogEntry, TTLResult } from "../types.js";

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
 *
 * Fleet-scale sharding (2026-08-04, ~1,069 routes): one batch is one
 * sequential ExtendFootprintTTLOp tx, so the whole fleet is ~54 txs —
 * far past the platform's 300s hard cap on this function (Pro without
 * Fluid ignores a higher maxDuration — see api/cron/weather.ts). Two
 * guards, mirroring jobs/weather.ts:
 *   1. SHARDS — each run covers a deterministic 1/7th of the keys (stable
 *      hash × UTC-day slot). At the weekly cadence the whole fleet is
 *      covered every 49 days, comfortably inside the 120-day route TTL
 *      (~2.4x margin). See the SHARDS constant: the shard count and the
 *      cron cadence are coupled and must be changed together.
 *   2. TIME_BUDGET_MS — the batch loop ALWAYS returns rather than risking
 *      a silent platform kill. A kill writes no cron_runs row at all,
 *      which makes a dead job look merely "not re-run"; returning early
 *      records an honest row plus the deferred count.
 */
async function extendIdlePersistentKeys(
  client: SorobanClient,
  config: Config,
  results: TTLResult[],
  actions: FetcherAction[],
  runStart: number
): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  const EXTEND_TO_LEDGERS = 120 * 17_280; // ~120 days at ~5s ledgers
  const BATCH = 20;
  // Shard count is coupled to the CRON CADENCE, not chosen freely: a full
  // fleet pass takes SHARDS × the interval, and that must stay well inside
  // the 120-day route TTL or keys archive and routes vanish from chain.
  //   daily  × 7 =   7 days  (17x margin)
  //   weekly × 7 =  49 days  (2.4x margin)  <- current
  //   monthly× 7 = 210 days  (0.57x)        <- would ARCHIVE ROUTES
  // If the cadence is ever slowed to monthly, SHARDS must drop to 2 to keep
  // a 2x margin — and each run then carries ~534 keys, which does NOT fit
  // the 300s budget today. Change both together or not at all.
  const SHARDS = 7;
  // Budget measured from the WHOLE run's start (instance extend_ttl, the
  // prune drain loop and the claim sweep all ran before this), leaving
  // headroom for the in-flight batch's confirmation poll to finish.
  const TIME_BUDGET_MS = 230_000;
  try {
    const sql = getDb();
    const routes = (await sql`select flight_id, origin, dest from routes`) as unknown as Array<{
      flight_id: string;
      origin: string;
      dest: string;
    }>;
    const buyers = (await sql`select distinct buyer from policies`) as unknown as Array<{ buyer: string }>;

    // Stable string hash → shard, the same technique jobs/weather.ts uses
    // to rotate its fleet slice (deliberately duplicated rather than
    // imported: job modules stay independent of each other).
    const shardOf = (s: string): number => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return (h >>> 0) % SHARDS;
    };
    const daySlot = Math.floor(Date.now() / 86_400_000) % SHARDS;
    const shardRoutes = routes.filter((r) => shardOf(`${r.flight_id}|${r.origin}|${r.dest}`) === daySlot);
    const shardBuyers = buyers.filter((b) => shardOf(String(b.buyer)) === daySlot);

    // OCA-M08: key construction is per-row isolated — one corrupted/empty
    // value (e.g. a bad `buyer` address) must skip THAT row, not abort TTL
    // maintenance for every route and buyer this run.
    const routeKeys: ReturnType<typeof client.scvVec>[] = [];
    for (const r of shardRoutes) {
      try {
        routeKeys.push(
          client.scvVec([
            client.symbolToScVal("Route"),
            client.symbolToScVal(r.flight_id),
            client.symbolToScVal(r.origin),
            client.symbolToScVal(r.dest),
          ])
        );
      } catch (err) {
        console.warn(`[ttl-extender] bad route row ${r.flight_id} ${r.origin}->${r.dest} skipped: ${err}`);
        results.push({ contract: `route key ${r.flight_id}`, success: false, error: String(err) });
      }
    }
    const travelerKeys: ReturnType<typeof client.scvVec>[] = [];
    for (const b of shardBuyers) {
      try {
        travelerKeys.push(
          client.scvVec([client.symbolToScVal("TravelerFlights"), client.addressToScVal(b.buyer)])
        );
      } catch (err) {
        console.warn(`[ttl-extender] bad buyer row ${JSON.stringify(b.buyer)} skipped: ${err}`);
        results.push({ contract: `traveler key ${String(b.buyer).slice(0, 12)}…`, success: false, error: String(err) });
      }
    }

    const jobs: Array<{ name: string; contractId: string; keys: ReturnType<typeof client.scvVec>[] }> = [
      { name: "governance Route", contractId: config.governanceId, keys: routeKeys },
      { name: "controller TravelerFlights", contractId: config.controllerId, keys: travelerKeys },
    ];

    // STARVATION FIX (2026-08-04) — this loop used to run job-by-job with
    // the governance Route keys FIRST. Routes alone overran the function's
    // budget, so the controller TravelerFlights batches were NEVER reached
    // on any run: dormant buyers got no key-level TTL extension at all,
    // silently, for as long as the job has existed. Interleave the jobs one
    // batch at a time so BOTH key types make guaranteed progress every run,
    // wherever the time budget happens to cut the pass short.
    const perJob = jobs.map((job) =>
      Array.from({ length: Math.ceil(job.keys.length / BATCH) }, (_, n) => ({
        name: job.name,
        contractId: job.contractId,
        offset: n * BATCH,
        keys: job.keys.slice(n * BATCH, n * BATCH + BATCH),
      }))
    );
    // Which batch goes FIRST rotates weekly: a given shard only comes round
    // every SHARDS days, so without the offset a run that keeps hitting the
    // time budget would drop the same tail of the same shard forever. The
    // offset is a bijection over the rounds — every batch is still queued
    // exactly once, just starting from a different one.
    const interleaved: (typeof perJob)[number] = [];
    const rounds = Math.max(0, ...perJob.map((b) => b.length));
    const weekOffset = Math.floor(Date.now() / 86_400_000 / SHARDS);
    for (let r = 0; r < rounds; r++) {
      const round = (r + weekOffset) % rounds;
      for (const batches of perJob) {
        const batch = batches[round];
        if (batch) interleaved.push(batch);
      }
    }

    let extended = 0;
    let deferredBatches = 0;
    let deferredKeys = 0;
    for (const batch of interleaved) {
      // Time budget: stop submitting rather than be killed mid-run. What
      // is left just waits for tomorrow's run — a ~120-day TTL does not
      // care about a day, and the shard rotation still covers the fleet.
      if (Date.now() - runStart > TIME_BUDGET_MS) {
        deferredBatches++;
        deferredKeys += batch.keys.length;
        continue;
      }
      try {
        await client.extendPersistentTtl(batch.contractId, batch.keys, EXTEND_TO_LEDGERS, config.ttlExtenderSecretKey);
        extended += batch.keys.length;
        results.push({
          contract: `extend ${batch.name} [${batch.offset}..${batch.offset + batch.keys.length - 1}]`,
          success: true,
        });
      } catch (err) {
        console.warn(`[ttl-extender] key-level extend ${batch.name} batch ${batch.offset} failed: ${err}`);
        results.push({ contract: `extend ${batch.name} [${batch.offset}..]`, success: false, error: String(err) });
      }
    }

    console.log(
      `[ttl-extender] key-level TTL: shard ${daySlot + 1}/${SHARDS} — ` +
        `${routeKeys.length}/${routes.length} route + ${travelerKeys.length}/${buyers.length} traveler key(s) ` +
        `selected, ${extended} extended.`
    );
    actions.push({
      flight: "-",
      skipped:
        `key-level TTL shard ${daySlot + 1}/${SHARDS}: ${routeKeys.length} route + ` +
        `${travelerKeys.length} traveler key(s) selected, ${extended} extended ` +
        `(fleet: ${routes.length} route + ${buyers.length} buyer(s), full rotation every ${SHARDS} days)`,
    });
    if (deferredBatches > 0) {
      console.log(
        `[ttl-extender] time budget reached — ${deferredKeys} key(s) in ${deferredBatches} batch(es) deferred to the next daily run`
      );
      actions.push({
        flight: "-",
        skipped: `${deferredKeys} key(s) in ${deferredBatches} batch(es) deferred (time budget) — next daily run continues`,
      });
    }
  } catch (err) {
    // Fold into the job's results so the ops board shows TTL maintenance
    // was NOT healthy this run (OCA-M08) — a bare log line hid this.
    console.warn(`[ttl-extender] key-level extend skipped (DB): ${err}`);
    results.push({ contract: "key-level extend (whole pass)", success: false, error: String(err) });
  }
}

export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const client = new SorobanClient(config);
  const results: TTLResult[] = [];
  // cron_runs only persists `actions` (not `results`) — the shard/deferred
  // counts go there so the ops board can see what this run covered.
  const actions: FetcherAction[] = [];

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
  // idle entries get no on-access bumps — extend them explicitly. Sharded
  // + time-budgeted, so it always returns inside the platform's 300s cap.
  await extendIdlePersistentKeys(client, config, results, actions, start);

  console.log("[ttl-extender] Done.");
  const allSuccess = results.every((r) => r.success);
  return {
    timestamp: new Date().toISOString(),
    job: "ttl_extender",
    duration_ms: Date.now() - start,
    success: allSuccess,
    error: allSuccess ? null : "Some contracts failed TTL extension",
    results,
    actions,
  };
}
