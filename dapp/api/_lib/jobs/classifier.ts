import { SorobanClient } from "../soroban_client";
import type { Config, RunLogEntry } from "../types";

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
  console.log(`[classifier] Calling Controller.classify_flights(${keeperPublicKey.slice(0, 8)}...)`);

  try {
    await client.invokeContract(
      config.controllerId,
      "classify_flights",
      [client.addressToScVal(keeperPublicKey)],
      config.keeperSecretKey
    );
    console.log("[classifier] classify_flights() completed ✓");
    return {
      timestamp: new Date().toISOString(),
      job: "classifier",
      duration_ms: Date.now() - start,
      success: true,
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
