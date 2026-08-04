import { SorobanClient } from "../soroban_client.js";
import type { Config, RunLogEntry } from "../types.js";

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

  try {
    // Pre-flight reads (free simulations) — submit a transaction ONLY when
    // it can actually do something:
    // 1. Barrier engaged (pending public outcomes): the vault's queue
    //    processors early-return on-chain, so the tx would be a paid no-op.
    //    The settler is responsible for clearing the barrier.
    const pending = BigInt(
      (await client.readContract(config.oracleAggregatorId, "get_pending_outcomes")) ?? 0
    );
    if (pending > 0n) {
      console.log(`[queue] Settlement barrier engaged (${pending} pending) — vault would no-op; skipping tx.`);
      return {
        timestamp: new Date().toISOString(),
        job: "queue_maintainer",
        duration_ms: Date.now() - start,
        success: true,
        actions: [{ flight: "-", skipped: `barrier engaged (${pending} pending) — no tx submitted` }],
      };
    }
    // 2. Nothing queued AND today's snapshot already recorded: nothing the
    //    call could do. (Snapshot is keyed by unix day — get_snapshot_price
    //    returns 0 for a missing day, so >0 means already snapshotted.)
    const [wdLen, depLen] = await Promise.all([
      client.readContract(config.riskVaultId, "get_withdrawal_queue_len"),
      client.readContract(config.riskVaultId, "get_deposit_queue_len"),
    ]);
    const today = BigInt(Math.floor(Date.now() / 1000 / 86_400));
    const snapshotToday = BigInt(
      (await client.readContract(config.riskVaultId, "get_snapshot_price", [
        client.u64ToScVal(today),
      ])) ?? 0
    );
    if (Number(wdLen ?? 0) === 0 && Number(depLen ?? 0) === 0 && snapshotToday > 0n) {
      console.log("[queue] Queues empty + snapshot done — skipping (no transaction).");
      return {
        timestamp: new Date().toISOString(),
        job: "queue_maintainer",
        duration_ms: Date.now() - start,
        success: true,
        actions: [{ flight: "-", skipped: "queues empty + snapshot done — no tx submitted" }],
      };
    }

    console.log(`[queue] Calling Controller.run_queue_maintenance(${keeperPublicKey.slice(0, 8)}...)`);
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
