import { SorobanClient } from "../soroban_client.js";
import type { Config, RunLogEntry } from "../types.js";

/**
 * Cron #2 — FlightClassifier (every 1 hour)
 *
 * Calls Controller.classify_flights(keeper) which:
 * - Reads OracleAggregator for Landed/Cancelled flights
 * - Computes delay vs threshold (from FlightPoolManager.get_flight_config)
 * - Sets ToBeSettled* status on OracleAggregator
 * - Emits sentinel.ttl_miss(flight_id, date) when oracle returns NotInitiated
 *   for a flight still in the active list (Phase 9 diagnostic)
 *
 * All classification logic lives on-chain. This cron just triggers it.
 */
export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const client = new SorobanClient(config);
  const keeperPublicKey = client.publicKeyFromSecret(config.keeperSecretKey);

  console.log("[classifier] Starting flight classification...");

  try {
    // Pre-flight read (free simulation): an empty active set means there is
    // nothing to classify, void, or diagnose — skip the tx entirely. When
    // ANY flights exist the hourly sweep still runs (it also handles the
    // 14-day timeout voids and ttl_miss diagnostics, which need the pass
    // even when no flight is Landed/Cancelled yet).
    const activeCount = Number(
      (await client.readContract(config.oracleAggregatorId, "get_active_flight_count")) ?? 0
    );
    if (activeCount === 0) {
      console.log("[classifier] Active set empty — skipping (no transaction).");
      return {
        timestamp: new Date().toISOString(),
        job: "classifier",
        duration_ms: Date.now() - start,
        success: true,
        actions: [{ flight: "-", skipped: "active set empty — no tx submitted" }],
      };
    }

    // One call scans MAX_CLASSIFY_BATCH (8) entries from a rotating on-chain
    // cursor, so a single call cannot cover a larger active set. The batch is
    // small because classification is bounded by the CPU-INSTRUCTION budget
    // (~5.9M per flight measured on testnet 2026-08-05) — at 25 it needed
    // ~147M against a 100M cap and reverted every time, which killed the job
    // outright once the fleet carried 50 policies.
    //
    // So loop: enough passes to cover the active set, bounded by a wall-clock
    // budget so the run always returns and records a row. Each pass is
    // idempotent on flights it already classified, so overshooting is free
    // and a partial sweep simply resumes from the cursor next hour.
    const CLASSIFY_BATCH = 8;
    const TIME_BUDGET_MS = 240_000;
    const passes = Math.min(Math.ceil(activeCount / CLASSIFY_BATCH), 12);
    let done = 0;
    for (let i = 0; i < passes; i++) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      await client.invokeContract(
        config.controllerId,
        "classify_flights",
        [client.addressToScVal(keeperPublicKey)],
        config.keeperSecretKey
      );
      done++;
    }
    const covered = done * CLASSIFY_BATCH;
    console.log(`[classifier] ${done}/${passes} pass(es) — up to ${covered} of ${activeCount} flight(s) ✓`);
    return {
      timestamp: new Date().toISOString(),
      job: "classifier",
      duration_ms: Date.now() - start,
      success: true,
      actions: [
        {
          flight: "-",
          skipped:
            done < passes
              ? `time budget: ${done}/${passes} passes, ~${activeCount - covered} flight(s) deferred to next run`
              : `${done} pass(es) covered the ${activeCount}-flight active set`,
        },
      ],
    };
  } catch (err) {
    console.error(`[classifier] Error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "classifier",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
    };
  }
}
