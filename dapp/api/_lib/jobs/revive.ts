import { AeroApiClient } from "../aeroapi_client";
import type { GovConfig } from "../governance/config";
import { executeRevive, pausedRoutes, sweepVerdict, type GovChainConfig } from "../route_guard";
import type { RunLogEntry, FetcherAction } from "../types";

/**
 * Cron — Revive check (daily).
 *
 * The counterpart to the route guard's cancellation pause: re-runs the
 * exact same 5-day sweep on the 20 MOST RECENTLY PAUSED routes (the
 * `route_health` table). A route whose flight is verifiably back —
 * ANY of the next 5 days tracked or published as operating — is
 * re-enabled on-chain and marked revived; a still-dead route stays
 * paused with its last_swept_at refreshed.
 *
 * Deliberately auto-healing: the criterion is the same objective check
 * that paused the route, so no admin ceremony is needed to undo it.
 * The admin surface is the same table (`route_health`), and the manual
 * companion — `scripts/revive_routes.ts` — runs this exact logic on ALL
 * paused routes (--all) for a full review.
 *
 * Cost: 2 AeroAPI calls per still-paused route, at most 20 routes, once
 * a day. Nothing paused (the normal state) → zero calls.
 */

const DEFAULT_LIMIT = 20;

export async function run(
  config: GovConfig,
  opts: { limit?: number | "all" } = {}
): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  const done = (success: boolean, error?: string): RunLogEntry => ({
    timestamp: new Date().toISOString(),
    job: "revive",
    duration_ms: Date.now() - start,
    success,
    ...(error ? { error } : {}),
    actions,
  });

  try {
    if (!process.env.GOVERNANCE_DB_URL) {
      console.log("[revive] No GOVERNANCE_DB_URL — no pause ledger to work from.");
      actions.push({ flight: "-", skipped: "no DB — nothing to revive" });
      return done(true);
    }
    const chainConfig: GovChainConfig = {
      stellarRpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      governanceAdminSecretKey: config.govAdminSecretKey,
    };
    const aero = new AeroApiClient({
      aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "https://aeroapi.flightaware.com/aeroapi",
      aeroApiKey: process.env.AEROAPI_KEY ?? "",
    });

    const limit = opts.limit === "all" ? null : (opts.limit ?? DEFAULT_LIMIT);
    const paused = await pausedRoutes(limit);
    if (paused.length === 0) {
      console.log("[revive] No paused routes.");
      return done(true);
    }
    console.log(`[revive] ${paused.length} paused route(s) to re-check.`);

    for (const route of paused) {
      const label = `${route.flight_id} ${route.origin}→${route.destination}`;
      try {
        const verdict = await sweepVerdict(aero, route);
        const alive = verdict.days.some((d) => d.state === "alive");
        console.log(
          `[revive] ${label}: ${verdict.days.map((d) => `${d.date}=${d.state}`).join(" ")}`
        );
        if (alive) {
          if (config.dryRun) {
            actions.push({ flight: label, skipped: "[dry-run] would revive — schedule is back" });
            continue;
          }
          await executeRevive(chainConfig, route, verdict, "cron:revive");
          actions.push({ flight: label, transition: "revived — schedule is back" });
        } else {
          actions.push({ flight: label, skipped: "still dead/unverifiable — stays paused" });
        }
      } catch (err) {
        console.error(`[revive] ${label}: Error — ${err}. Will retry next run.`);
        actions.push({ flight: label, error: String(err) });
      }
    }

    return done(true);
  } catch (err) {
    console.error(`[revive] Fatal error: ${err}`);
    return done(false, String(err));
  }
}
