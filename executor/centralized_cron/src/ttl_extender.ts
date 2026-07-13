import { SorobanClient } from "./soroban_client.js";
import type { Config, RunLogEntry, TTLResult } from "./types.js";

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
 *    in `Settled` status for at least 7 days from the active set
 *    (Phase 6 permissionless cleanup, no auth required).
 *
 * Contract list updated from phase-2: recovery_pool is gone (folded into
 * FlightPoolManager); flight_pool_manager is the new singleton.
 *
 * Deeper key-level Persistent TTL extension (FlightConfig, FlightData,
 * Route, TravelerFlights, ClaimableBalance, buyer proofs via
 * ExtendFootprintTTLOp) is a separate executor concern (Improvement #6) —
 * not in this cron. Whitelist approvals (BuyerApprovalExpiry) need no
 * extension for correctness: their 180-day lifetime is an explicit on-chain
 * deadline, and an archived entry restores with that deadline intact.
 */
export async function runTTLExtender(config: Config): Promise<RunLogEntry> {
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

  // Phase 6 — permissionless prune of aged-settled flights from the
  // OracleAggregator active set. Idempotent; safe to run daily.
  try {
    await client.invokeContract(
      config.oracleAggregatorId,
      "prune_settled",
      [],
      config.ttlExtenderSecretKey
    );
    console.log("[ttl-extender] OracleAggregator.prune_settled() done");
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
