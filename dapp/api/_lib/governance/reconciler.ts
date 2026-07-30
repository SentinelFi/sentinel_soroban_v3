import type { FetcherAction, RunLogEntry } from "../types";
import type { GovConfig } from "./config";
import { getDb } from "./db";
import type { RouteRow, SignalRow } from "./model";
import {
  HYSTERESIS_HOURS,
  decideReconcileAction,
  isPause,
  signalMatchesRoute,
  type ReconcileAction,
} from "./rules";
import { GovSubmitter } from "./submitter";

/**
 * Gov cron — Reconciler (hourly, :10 — after the signal collectors).
 *
 * Layer 2 of the governance architecture: signals are facts in the DB;
 * this is the only thing that acts on them. Since the 2026-07-30
 * simplification it is a PAUSE ENGINE ONLY — premiums are owned by the
 * seeding/monthly-repricing ritual (base) and jobs/weather.ts (flat
 * surcharge). For every managed route:
 *
 * 1. Gather DB state — active SEVERE signals matched to the route's
 *    scope (route | origin | dest expansion), open pause_events,
 *    hysteresis lookbacks. Elevated signals are advisory (no action).
 * 2. Read the actual on-chain route_status.
 * 3. decideReconcileAction (pure rules — pin wins, pauses expand,
 *    hysteresis damps re-enables).
 * 4. Execute the minimal on-chain diff via GovSubmitter (which writes
 *    actions_log), and mirror it in pause_events.
 *
 * Idempotent by design: desired state is recomputed from scratch every
 * run, so a crashed run heals on the next tick. GOV_DRY_RUN=true logs
 * decisions without submitting or writing.
 */

const ACTOR = "cron:reconciler";

/**
 * Fleet-level mass-disable circuit breaker (2026-07-27 audit): one broad
 * severe signal (e.g. a hub-wide red delay) matches many routes at once,
 * and without a cap the reconciler would pause the entire fleet in a
 * single tick. Per-run disables are capped at max(3, 20% of managed
 * routes); anything beyond is FLAGGED for the admin board instead of
 * executed — a storm can slow the fleet, only a human can stop it.
 * Exported for tests.
 */
export function computeDisableCap(routeCount: number): number {
  return Math.max(3, Math.ceil(routeCount * 0.2));
}

/** Routes with ≥ this many pause-state transitions in 24h are flap-damped. */
const FLAP_TRANSITIONS_PER_DAY = 2;

export async function run(config: GovConfig): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  const sql = getDb();

  try {
    // Runtime kill switch — admin-toggleable without a redeploy (unlike
    // GOV_DRY_RUN). Absent row = not frozen.
    const frozen = (await sql`
      select value, note from ops_flags where key = 'gov_frozen'
    `) as unknown as Array<{ value: boolean; note: string | null }>;
    if (frozen[0]?.value) {
      console.warn(`[gov-reconcile] FROZEN via ops_flags.gov_frozen${frozen[0].note ? ` (${frozen[0].note})` : ""} — no actions this run.`);
      return {
        timestamp: new Date().toISOString(),
        job: "gov_reconcile",
        duration_ms: Date.now() - start,
        success: true,
        actions: [{ flight: "-", skipped: "governance frozen (ops_flags.gov_frozen) — no actions" }],
      };
    }

    const submitter = new GovSubmitter({
      rpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      adminSecretKey: config.govAdminSecretKey,
      actor: ACTOR,
    });

    // 1. Gather DB state in bulk (one query each, matched in memory).
    const routes = (await sql`
      select * from routes where status in ('active', 'disabled')
    `) as unknown as RouteRow[];

    const activeSignals = (await sql`
      select * from signals
      where cleared_at is null and (expires_at is null or expires_at > now())
    `) as unknown as SignalRow[];

    // Signals that ENDED inside the hysteresis window — a route touched
    // by one of these is not yet "clear for N consecutive checks".
    const recentlyEnded = (await sql`
      select * from signals
      where coalesce(cleared_at, expires_at) > now() - make_interval(hours => ${HYSTERESIS_HOURS})
        and (cleared_at is not null or expires_at <= now())
    `) as unknown as SignalRow[];

    const openPauses = (await sql`
      select flight_id, origin, dest from pause_events where ended_at is null
    `) as unknown as Array<{ flight_id: string; origin: string; dest: string }>;

    // Flap damping: routes whose pause state changed ≥2× in 24h (each
    // pause_events row contributes its start and, if today, its end) get
    // no further disable/enable transitions today — only flags.
    const flapCounts = (await sql`
      select flight_id, origin, dest,
             count(*) filter (where started_at > now() - interval '24 hours')
             + count(*) filter (where ended_at   > now() - interval '24 hours') as n
      from pause_events
      where started_at > now() - interval '24 hours'
         or ended_at   > now() - interval '24 hours'
      group by flight_id, origin, dest
    `) as unknown as Array<{ flight_id: string; origin: string; dest: string; n: string }>;

    const keyOf = (r: { flight_id: string; origin: string; dest: string }) =>
      `${r.flight_id}|${r.origin}|${r.dest}`;
    const openPauseSet = new Set(openPauses.map(keyOf));
    const flapSet = new Set(
      flapCounts.filter((r) => Number(r.n) >= FLAP_TRANSITIONS_PER_DAY).map(keyOf)
    );
    const disableCap = computeDisableCap(routes.length);
    let disablesThisRun = 0;

    console.log(
      `[gov-reconcile] ${routes.length} route(s), ${activeSignals.length} active signal(s)` +
        (config.dryRun ? " [DRY RUN]" : "")
    );

    for (const route of routes) {
      const label = `${route.flight_id} ${route.origin}→${route.dest}`;
      const routeKey = { flightId: route.flight_id, origin: route.origin, dest: route.dest };
      try {
        // 2. On-chain actual
        const onChain = await submitter.readStatus(routeKey);

        // 3. Decide (pause engine — elevated signals are advisory only)
        const matching = activeSignals.filter((s) => signalMatchesRoute(s, route));
        const action = decideReconcileAction({
          route,
          onChain,
          pauses: matching.filter(isPause),
          recentlyCleared: recentlyEnded.some((s) => signalMatchesRoute(s, route)),
          hasOpenPauseEvent: openPauseSet.has(keyOf(route)),
        });

        console.log(`[gov-reconcile] ${label}: on-chain=${onChain.status} → ${action.kind} (${action.reason})`);

        // 3b. Fleet guardrails — cap and damp BEFORE executing.
        if (action.kind === "disable" || action.kind === "enable") {
          if (flapSet.has(keyOf(route))) {
            console.warn(`[gov-reconcile] FLAP-DAMPED ${label}: ≥${FLAP_TRANSITIONS_PER_DAY} pause transitions in 24h — flagging instead of ${action.kind}.`);
            actions.push({ flight: label, skipped: `flap-damped: would ${action.kind} (${action.reason})` });
            continue;
          }
        }
        if (action.kind === "disable") {
          if (disablesThisRun >= disableCap) {
            console.warn(`[gov-reconcile] CIRCUIT BREAKER ${label}: disable cap ${disableCap} reached this run — flagging for admin.`);
            actions.push({ flight: label, skipped: `circuit breaker: would disable (${action.reason}) — cap ${disableCap} reached` });
            continue;
          }
          disablesThisRun++;
        }

        // 4. Execute
        if (config.dryRun) {
          actions.push({ flight: label, skipped: `[dry-run] ${action.kind}: ${action.reason}` });
          continue;
        }
        actions.push(await execute(sql, submitter, route, routeKey, action));
      } catch (err) {
        console.error(`[gov-reconcile] ${label}: Error — ${err}. Will retry next run.`);
        actions.push({ flight: label, error: String(err) });
      }
    }

    return {
      timestamp: new Date().toISOString(),
      job: "gov_reconcile",
      duration_ms: Date.now() - start,
      success: true,
      actions,
    };
  } catch (err) {
    console.error(`[gov-reconcile] Fatal error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "gov_reconcile",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
      actions,
    };
  }
}

async function execute(
  sql: ReturnType<typeof getDb>,
  submitter: GovSubmitter,
  route: RouteRow,
  routeKey: { flightId: string; origin: string; dest: string },
  action: ReconcileAction
): Promise<FetcherAction> {
  const label = `${route.flight_id} ${route.origin}→${route.dest}`;

  switch (action.kind) {
    case "noop":
      return { flight: label, skipped: action.reason };

    case "flag":
      // Surfaced in the admin UI via the run log; deliberately no
      // on-chain call and no state write.
      console.warn(`[gov-reconcile] FLAG ${label}: ${action.reason}`);
      return { flight: label, skipped: `flagged: ${action.reason}` };

    case "disable": {
      await submitter.disable(routeKey);
      await sql`
        insert into pause_events (flight_id, origin, dest, signal_id, reason, actor)
        values (${route.flight_id}, ${route.origin}, ${route.dest},
                ${action.signalIds[0] ?? null}, ${action.reason}, ${ACTOR})
      `;
      return { flight: label, transition: `disabled (${action.reason})` };
    }

    case "enable": {
      await submitter.enable(routeKey);
      await sql`
        update pause_events set ended_at = now()
        where flight_id = ${route.flight_id} and origin = ${route.origin}
          and dest = ${route.dest} and ended_at is null
      `;
      return { flight: label, transition: `re-enabled (${action.reason})` };
    }
  }
}
