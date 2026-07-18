import type { SorobanClient } from "./soroban_client";
import type { Config, FetcherAction } from "./types";

/**
 * Best-effort targeted classify + settle for one exact flight instance,
 * called right after an outcome write (`set_landed` / `set_cancelled`).
 *
 * The rotating keeper sweeps guarantee eventual coverage, but their latency
 * grows with total active-set occupancy, and while a written outcome waits
 * for the cursors the vault's settlement barrier blocks every LP entry/exit
 * protocol-wide. The writer knows exactly which tuple just changed, so it
 * drives that tuple straight through `classify_flight` → `settle_flight`
 * (keeper key) and releases the barrier within seconds instead of rotations.
 *
 * Failures are logged and swallowed: the sweeps remain the repair backstop,
 * so a paused controller, RPC glitch, or lost race with a concurrent sweep
 * only delays settlement, never loses it. Skips flights the oracle does not
 * list (e.g. pre-registration cancellation tombstones — nothing to settle).
 */
export async function classifyAndSettleFlight(
  client: SorobanClient,
  config: Config,
  flightId: string,
  dateSecs: bigint,
  label: string,
  actions: FetcherAction[]
): Promise<void> {
  try {
    const listed = await client.readContract(config.oracleAggregatorId, "is_flight_listed", [
      client.symbolToScVal(flightId),
      client.u64ToScVal(dateSecs),
    ]);
    if (!listed) {
      return;
    }

    const keeperPublicKey = client.publicKeyFromSecret(config.keeperSecretKey);
    const args = [
      client.addressToScVal(keeperPublicKey),
      client.symbolToScVal(flightId),
      client.u64ToScVal(dateSecs),
    ];
    await client.invokeContract(
      config.controllerId,
      "classify_flight",
      args,
      config.keeperSecretKey
    );
    await client.invokeContract(
      config.controllerId,
      "settle_flight",
      args,
      config.keeperSecretKey
    );
    console.log(`[targeted] ${label}: classified + settled directly`);
    actions.push({ flight: label, transition: "targeted classify + settle" });
  } catch (err) {
    console.warn(
      `[targeted] ${label}: targeted settlement failed (${err}) — the keeper sweeps will cover it.`
    );
  }
}
