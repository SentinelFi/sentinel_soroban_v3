import { SorobanClient } from "../soroban_client";
import type { Config, RunLogEntry, TTLResult } from "../types";

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
