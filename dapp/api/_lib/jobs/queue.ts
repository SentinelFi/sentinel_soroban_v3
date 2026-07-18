import { SorobanClient } from "../soroban_client";
import type { Config, RunLogEntry } from "../types";

/**
 * Cron #3b — QueueMaintainer (every 5 minutes, decoupled from settler)
 *
 * Calls Controller.run_queue_maintenance(keeper) which:
 * - Drains the underwriter withdrawal queue (RiskVault.process_withdrawal_queue)
 * - Records the daily share-price snapshot (RiskVault.snapshot, gated by 24h)
 *
 * Phase 3 / audit M-03 split this out of execute_settlements so heavy
 * settlement runs can't starve underwriter payouts. Same keeper key as the
 * settler — the same authorized address gates both entry points on
 * Controller. Schedule them off-tempo to avoid sequence-number contention
 * (vercel.json: settle on minute 0/5/10/..., queue on minute 2/7/12/...).
 */
export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const client = new SorobanClient(config);
  const keeperPublicKey = client.publicKeyFromSecret(config.keeperSecretKey);

  console.log("[queue] Starting queue maintenance...");
  console.log(`[queue] Calling Controller.run_queue_maintenance(${keeperPublicKey.slice(0, 8)}...)`);

  try {
    await client.invokeContract(
      config.controllerId,
      "run_queue_maintenance",
      [client.addressToScVal(keeperPublicKey)],
      config.keeperSecretKey
    );
    console.log("[queue] run_queue_maintenance() completed ✓");
    return {
      timestamp: new Date().toISOString(),
      job: "queue_maintainer",
      duration_ms: Date.now() - start,
      success: true,
    };
  } catch (err) {
    console.error(`[queue] Error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "queue_maintainer",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
    };
  }
}
