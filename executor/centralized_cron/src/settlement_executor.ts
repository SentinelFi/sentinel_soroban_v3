import { SorobanClient } from "./soroban_client.js";
import type { Config, RunLogEntry } from "./types.js";

/**
 * Cron #3 — SettlementExecutor (every 5 minutes)
 *
 * Calls Controller.execute_settlements(keeper) which processes ToBeSettled*
 * flights in a bounded rotating window — at most 10 per call, sized to the
 * per-transaction write and event budgets (moves money between
 * FlightPoolManager and RiskVault, marks flights Settled). A backlog larger
 * than one window drains across successive cron ticks; if a window ever
 * exceeds the network resource limits, an operator can call
 * Controller.execute_settlements_bounded(keeper, limit) with a smaller
 * window (down to 1) to keep the cursor advancing.
 *
 * Note: queue drain + share-price snapshot are NO LONGER part of this
 * call. Audit M-03 split them out into Controller.run_queue_maintenance so
 * settlement gas pressure can't block underwriter payouts. The
 * `queue_maintainer.ts` cron handles that on its own cadence.
 */
export async function runSettlementExecutor(config: Config): Promise<RunLogEntry> {
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
