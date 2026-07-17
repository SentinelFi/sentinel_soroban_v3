import { SorobanClient } from "./soroban_client.js";
import type { Config, RunLogEntry } from "./types.js";

// Bounds on the per-run drain loop below. MAX_PASSES caps fee spend per run
// (each pass is two keeper transactions); MAX_STALLED_PASSES stops early
// when repeated passes leave the pending-outcome count unchanged — e.g.
// every remaining outcome is diagnosed FlightConfigMissing — instead of
// burning the full pass budget every five minutes on a stuck state. The
// persisted on-chain cursors mean the next run resumes where this one left
// off, so breaking out never loses coverage.
const MAX_PASSES = 10;
const MAX_STALLED_PASSES = 3;

/**
 * Cron #3 — SettlementExecutor (every 5 minutes)
 *
 * Drives Controller.classify_flights + Controller.execute_settlements in a
 * loop until the oracle reports no pending outcomes (or the per-run pass
 * budget runs out). While ANY outcome is pending the vault blocks every LP
 * entry/exit protocol-wide, so the drain target is `PendingOutcomes == 0` —
 * not merely "one settlement window submitted": one window covers at most
 * 10 consecutive active-set slots and a large mixed set can take many
 * rotations to reach a ready row. Classification runs inside the loop
 * because a pending outcome cannot settle before it is classified, and the
 * hourly classifier alone would leave outcomes blocking the vault for up to
 * an hour when the targeted per-flight path (see targeted_settlement.ts)
 * missed them.
 *
 * Each settlement window processes at most 10 flights, sized to the
 * per-transaction write and event budgets (moves money between
 * FlightPoolManager and RiskVault, marks flights Settled). If a window ever
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

  try {
    let pending = Number(
      (await client.readContract(config.oracleAggregatorId, "get_pending_outcomes")) ?? 0
    );
    if (pending === 0) {
      console.log("[settler] No pending outcomes — nothing to settle.");
      return {
        timestamp: new Date().toISOString(),
        job: "settler",
        duration_ms: Date.now() - start,
        success: true,
      };
    }

    let stalled = 0;
    for (let pass = 0; pass < MAX_PASSES && pending > 0; pass++) {
      console.log(
        `[settler] Pass ${pass + 1}: ${pending} pending outcome(s) — classify + settle window`
      );
      await client.invokeContract(
        config.controllerId,
        "classify_flights",
        [client.addressToScVal(keeperPublicKey)],
        config.keeperSecretKey
      );
      await client.invokeContract(
        config.controllerId,
        "execute_settlements",
        [client.addressToScVal(keeperPublicKey)],
        config.keeperSecretKey
      );

      const after = Number(
        (await client.readContract(config.oracleAggregatorId, "get_pending_outcomes")) ?? 0
      );
      stalled = after < pending ? 0 : stalled + 1;
      pending = after;
      if (stalled >= MAX_STALLED_PASSES) {
        console.warn(
          `[settler] No progress after ${MAX_STALLED_PASSES} passes with ${pending} outcome(s) still pending — deferring to the next run's cursors.`
        );
        break;
      }
    }

    if (pending === 0) {
      console.log("[settler] All pending outcomes settled ✓");
    } else {
      console.warn(`[settler] ${pending} outcome(s) still pending after this run.`);
    }
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
