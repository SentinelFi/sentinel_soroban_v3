import { SorobanClient } from "../soroban_client";
import type { Config, RunLogEntry } from "../types";

/**
 * Cron #3 — SettlementExecutor (every 5 minutes)
 *
 * Calls Controller.execute_settlements(keeper) which processes all
 * ToBeSettled* flights (moves money between FlightPoolManager and RiskVault,
 * marks flights Settled).
 *
 * Note: queue drain + share-price snapshot are NO LONGER part of this
 * call. Audit M-03 split them out into Controller.run_queue_maintenance so
 * settlement gas pressure can't block underwriter payouts. The
 * `queue.ts` cron handles that on its own cadence.
 */
export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const client = new SorobanClient(config);
  const keeperPublicKey = client.publicKeyFromSecret(config.keeperSecretKey);

  console.log("[settler] Starting settlement execution...");
  console.log(`[settler] Calling Controller.execute_settlements(${keeperPublicKey.slice(0, 8)}...)`);

  try {
    await client.invokeContract(
      config.controllerId,
      "execute_settlements",
      [client.addressToScVal(keeperPublicKey)],
      config.keeperSecretKey
    );
    console.log("[settler] execute_settlements() completed ✓");
    return {
      timestamp: new Date().toISOString(),
      job: "settler",
      duration_ms: Date.now() - start,
      success: true,
    };
  } catch (err) {
    console.error(`[settler] Error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "settler",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
    };
  }
}
