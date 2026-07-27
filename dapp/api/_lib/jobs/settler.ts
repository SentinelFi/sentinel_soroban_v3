import { SorobanClient } from "../soroban_client";
import { getDb } from "../governance/db";
import type { Config, FetcherAction, RunLogEntry } from "../types";

/**
 * Best-effort barrier-age bookkeeping (ops_flags key 'barrier'): records
 * WHEN the settlement barrier first engaged so health/status can alert on
 * its AGE, not just its existence. Strictly DB-optional — no DB, no rows,
 * no failures (the settler is a keeper-tier bot).
 */
async function recordBarrierState(pending: bigint): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const sql = getDb();
    if (pending === 0n) {
      await sql`
        insert into ops_flags (key, value, data, updated_at)
        values ('barrier', false, null, now())
        on conflict (key) do update set value = false, data = null, updated_at = now()
      `;
      return;
    }
    // Preserve the original first-seen timestamp while the barrier stays up.
    await sql`
      insert into ops_flags (key, value, data, updated_at)
      values ('barrier', true,
              ${sql.json({ since: new Date().toISOString(), pending: Number(pending) })}, now())
      on conflict (key) do update
        set value = true,
            data = case
              when ops_flags.value then jsonb_set(coalesce(ops_flags.data, '{}'::jsonb), '{pending}', to_jsonb(${Number(pending)}::int))
              else excluded.data
            end,
            updated_at = now()
    `;
  } catch (err) {
    console.warn(`[settler] barrier-state record failed (ignored): ${err}`);
  }
}

// Bounded drain: each pass is one classify_flights (window 25) + one
// execute_settlements (window 10). 8 passes ≈ 80 settlements per run —
// far beyond any realistic backlog, well inside the 300s maxDuration.
const MAX_DRAIN_PASSES = 8;

/**
 * Cron #3 — SettlementExecutor (every 5 minutes)
 *
 * The vault blocks EVERY LP entry/exit from the moment an outcome is
 * written until it settles (`PendingOutcomes > 0`), so this job's mission
 * is: get pending outcomes to zero, fast, and spend nothing when there is
 * nothing to do.
 *
 * 1. Pre-flight read (free simulation): `oracle.get_pending_outcomes()`.
 *    Zero pending → NO transaction at all. (The empty-path on-chain call
 *    still writes TTL extensions — a real fee — so blind 5-minute submits
 *    were pure waste.)
 * 2. Drain loop: alternate `classify_flights` (promotes Landed/Cancelled →
 *    ToBeSettled*, window 25) and `execute_settlements` (moves money,
 *    window 10) until pending hits zero, progress stalls, or
 *    MAX_DRAIN_PASSES. A backlog larger than one window drains in ONE run
 *    instead of dribbling out across 5-minute ticks.
 * 3. Resource-budget fallback: if `execute_settlements` fails, retry the
 *    pass with `execute_settlements_bounded(keeper, 3)` then `(keeper, 1)`
 *    — the contract's escape hatch for windows that exceed per-tx budgets;
 *    without this a consistently-oversized batch would stall settlement
 *    forever.
 *
 * Note: queue drain + share-price snapshot live in run_queue_maintenance
 * (audit M-03 split) on their own cadence — see queue.ts.
 */
export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  const client = new SorobanClient(config);
  const keeperPublicKey = client.publicKeyFromSecret(config.keeperSecretKey);
  const keeperArg = [client.addressToScVal(keeperPublicKey)];

  const entry = (success: boolean, error?: string): RunLogEntry => ({
    timestamp: new Date().toISOString(),
    job: "settler",
    duration_ms: Date.now() - start,
    success,
    ...(error ? { error } : {}),
    actions,
  });

  try {
    const readPending = async (): Promise<bigint> =>
      BigInt((await client.readContract(config.oracleAggregatorId, "get_pending_outcomes")) ?? 0);

    let pending = await readPending();
    await recordBarrierState(pending);
    if (pending === 0n) {
      console.log("[settler] No pending outcomes — skipping (no transaction).");
      actions.push({ flight: "-", skipped: "no pending outcomes — no tx submitted" });
      return entry(true);
    }

    console.log(`[settler] ${pending} pending outcome(s) — draining...`);

    let stalls = 0;
    for (let pass = 1; pass <= MAX_DRAIN_PASSES && pending > 0n; pass++) {
      // Classify first: an outcome written since the last hourly classifier
      // tick is pending but not yet ToBeSettled — execute_settlements alone
      // could never release it.
      try {
        await client.invokeContract(config.controllerId, "classify_flights", keeperArg, config.keeperSecretKey);
      } catch (err) {
        console.error(`[settler] pass ${pass}: classify_flights failed: ${err}`);
        actions.push({ flight: `pass ${pass}`, error: `classify_flights: ${err}` });
      }

      try {
        await client.invokeContract(config.controllerId, "execute_settlements", keeperArg, config.keeperSecretKey);
      } catch (err) {
        // Escape hatch: shrink the window (10 → 3 → 1) so an oversized
        // batch still makes progress instead of retry-failing forever.
        console.warn(`[settler] pass ${pass}: execute_settlements failed (${err}) — trying bounded windows...`);
        let bounded = false;
        for (const limit of [3, 1]) {
          try {
            await client.invokeContract(
              config.controllerId,
              "execute_settlements_bounded",
              [client.addressToScVal(keeperPublicKey), client.u32ToScVal(limit)],
              config.keeperSecretKey
            );
            actions.push({ flight: `pass ${pass}`, transition: `settled with bounded window ${limit}` });
            bounded = true;
            break;
          } catch (err2) {
            console.error(`[settler] pass ${pass}: bounded(${limit}) also failed: ${err2}`);
          }
        }
        if (!bounded) {
          actions.push({ flight: `pass ${pass}`, error: `execute_settlements + bounded fallbacks failed: ${err}` });
        }
      }

      const next = await readPending();
      if (next >= pending) {
        stalls++;
        if (stalls >= 2) {
          // Two passes with no progress: a flight the sweeps cannot settle
          // (missing config, paused contract, stalled restore). Stop burning
          // fees — this needs the ops runbook, and the pending-age monitor
          // is the alarm.
          console.error(
            `[settler] No progress after ${pass} pass(es), ${next} outcome(s) still pending — ` +
              `needs operator attention (see evict_missing_flight / restore runbook).`
          );
          actions.push({ flight: "-", error: `stalled with ${next} pending outcome(s)` });
          return entry(false, `stalled with ${next} pending outcome(s)`);
        }
      } else {
        stalls = 0;
      }
      pending = next;
    }

    console.log(`[settler] Done — ${pending} pending outcome(s) remaining.`);
    await recordBarrierState(pending);
    actions.push({ flight: "-", transition: `drained to ${pending} pending` });
    return entry(true);
  } catch (err) {
    console.error(`[settler] Error: ${err}`);
    return entry(false, String(err));
  }
}
