import { AeroApiClient } from "../aeroapi_client";
import type { GovConfig } from "../governance/config";
import {
  openInterventions,
  recordClearCheck,
  reviveRoute,
  touchIntervention,
  type GovChainConfig,
  type InterventionRow,
} from "../governance/interventions";
import {
  computeConcentrations,
  exposureContractIds,
  exposureReadClient,
  readExposure,
} from "../governance/exposure_collector";
import { sweepVerdict } from "../route_guard";
import { isExtremeForecast } from "../route_rules";
import { loadRoutesConfig } from "../routes_config";
import { WeatherClient } from "../weather_client";
import type { RunLogEntry, FetcherAction } from "../types";

/**
 * Cron — the unified REVIVE engine (hourly).
 *
 * The single counterpart to every automated pause: reads the open rows in
 * the `interventions` ledger and applies each cause's own "is it safe to
 * turn back on?" predicate. One job, four predicates, per-cause cadence:
 *
 *   cancellation  re-run the guard's 5-day sweep (2 AeroAPI calls) — ANY
 *                 day verifiably operating → revive. Re-checked ~daily
 *                 (20h gate; schedules don't change hourly), 20 most
 *                 recent per run — `scripts/revive_routes.ts --all`
 *                 forces the full list.
 *   exposure      recompute concentration from chain state (free reads) —
 *                 route AND both airport fractions below the severe
 *                 threshold for 2 CONSECUTIVE hourly checks → revive
 *                 (settlements free capacity; hysteresis stops flapping).
 *   weather       re-fetch the Open-Meteo forecast (free) — no longer
 *                 EXTREME at either airport → revive, the same hour.
 *   pricing       skipped here: the monthly reprice run re-prices every
 *                 route and closes its own rows when the honest price is
 *                 back under the cap.
 *   admin         never auto-revived — a human closes it.
 *
 * A route re-enables only when its LAST open intervention closes (the
 * executor enforces that), so overlapping causes heal independently and
 * an admin hold beats everything. Nothing open (the normal state) → zero
 * API calls.
 */

const CANCELLATION_RECHECK_HOURS = 20;
const CANCELLATION_BATCH = 20;
const EXPOSURE_CLEAR_STREAK = 2;
const SEVERE_PCT = Number(process.env.EXPOSURE_SEVERE_PCT ?? 0.5);
// OCA-M04: stop starting new AeroAPI work past this run age — the cron's
// maxDuration is 300s and a hard platform kill mid-chain-write must never
// be reachable via stacked 429 cooldowns. Unprocessed rows wait for the
// next hourly run.
const RUN_BUDGET_MS = 240_000;

export async function run(
  config: GovConfig,
  opts: { forceAll?: boolean } = {}
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
      console.log("[revive] No GOVERNANCE_DB_URL — no ledger to work from.");
      actions.push({ flight: "-", skipped: "no DB — nothing to revive" });
      return done(true);
    }
    const chainConfig: GovChainConfig = {
      stellarRpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      governanceAdminSecretKey: config.govAdminSecretKey,
    };

    const open = await openInterventions();
    if (open.length === 0) {
      console.log("[revive] Ledger clean — nothing paused.");
      return done(true);
    }
    console.log(`[revive] ${open.length} open intervention(s).`);

    const asRoute = (row: InterventionRow) => ({
      flight_id: row.flight_id,
      origin: row.origin,
      destination: row.dest,
    });
    const labelOf = (row: InterventionRow) =>
      `${row.flight_id} ${row.origin}→${row.dest} [${row.cause}]`;

    // ── cancellation — daily-ish sweep, batched ────────────────────────
    const deadline = start + RUN_BUDGET_MS;
    const aero = new AeroApiClient({
      aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "https://aeroapi.flightaware.com/aeroapi",
      aeroApiKey: process.env.AEROAPI_KEY ?? "",
    });
    aero.setDeadline(deadline);
    const cancelRows = open.filter((r) => r.cause === "cancellation");
    const due = opts.forceAll
      ? cancelRows
      : cancelRows
          .filter(
            (r) =>
              Date.now() - new Date(r.last_checked_at).getTime() >
              CANCELLATION_RECHECK_HOURS * 3600_000
          )
          .slice(0, CANCELLATION_BATCH);
    for (const row of due) {
      if (Date.now() > deadline) {
        actions.push({ flight: labelOf(row), skipped: "run time budget exhausted — recheck deferred to next run" });
        continue;
      }
      try {
        const verdict = await sweepVerdict(aero, asRoute(row));
        const alive = verdict.days.some((d) => d.state === "alive");
        console.log(
          `[revive] ${labelOf(row)}: ${verdict.days.map((d) => `${d.date}=${d.state}`).join(" ")}`
        );
        if (alive && !config.dryRun) {
          const outcome = await reviveRoute(chainConfig, asRoute(row), "cancellation", "cron:revive");
          actions.push({ flight: labelOf(row), transition: outcome });
        } else if (alive) {
          actions.push({ flight: labelOf(row), skipped: "[dry-run] would revive — schedule is back" });
        } else {
          await touchIntervention(row.id, verdict.days);
          actions.push({ flight: labelOf(row), skipped: "still dead/unverifiable — stays paused" });
        }
      } catch (err) {
        console.error(`[revive] ${labelOf(row)}: ${err}. Next run retries.`);
        actions.push({ flight: labelOf(row), error: String(err) });
      }
    }

    // ── weather — hourly forecast re-check ─────────────────────────────
    const weatherRows = open.filter((r) => r.cause === "weather");
    if (weatherRows.length > 0) {
      const routesConfig = loadRoutesConfig();
      const weather = new WeatherClient(
        process.env.WEATHER_BASE_URL ?? "https://api.open-meteo.com/v1/forecast",
        routesConfig.weatherHorizonDays
      );
      const forecastCache = new Map<string, Awaited<ReturnType<WeatherClient["getForecast"]>>>();
      const getForecast = async (iata: string) => {
        if (!forecastCache.has(iata)) forecastCache.set(iata, await weather.getForecast(iata));
        return forecastCache.get(iata)!;
      };
      for (const row of weatherRows) {
        try {
          const [o, d] = [await getForecast(row.origin), await getForecast(row.dest)];
          const stillExtreme = isExtremeForecast(o) || isExtremeForecast(d);
          if (!stillExtreme && !config.dryRun) {
            const outcome = await reviveRoute(chainConfig, asRoute(row), "weather", "cron:revive");
            actions.push({ flight: labelOf(row), transition: outcome });
          } else if (!stillExtreme) {
            actions.push({ flight: labelOf(row), skipped: "[dry-run] would revive — forecast cleared" });
          } else {
            await touchIntervention(row.id);
            actions.push({ flight: labelOf(row), skipped: "forecast still extreme — stays paused" });
          }
        } catch (err) {
          console.error(`[revive] ${labelOf(row)}: ${err}. Next run retries.`);
          actions.push({ flight: labelOf(row), error: String(err) });
        }
      }
    }

    // ── exposure — hourly concentration re-check with hysteresis ───────
    const exposureRows = open.filter((r) => r.cause === "exposure");
    if (exposureRows.length > 0) {
      try {
        const { poolId, vaultId } = exposureContractIds();
        const { flights, totalManaged } = await readExposure(exposureReadClient(config), {
          flightPoolManagerId: poolId,
          riskVaultId: vaultId,
        });
        const conc = computeConcentrations(flights, totalManaged);
        for (const row of exposureRows) {
          const routeFrac =
            conc.routes.get(`${row.flight_id}|${row.origin}|${row.dest}`)?.fraction ?? 0;
          const originFrac = conc.airports.get(row.origin) ?? 0;
          const destFrac = conc.airports.get(row.dest) ?? 0;
          const eased = routeFrac < SEVERE_PCT && originFrac < SEVERE_PCT && destFrac < SEVERE_PCT;
          if (!eased) {
            await touchIntervention(row.id, { routeFrac, originFrac, destFrac });
            actions.push({ flight: labelOf(row), skipped: `still concentrated (${(Math.max(routeFrac, originFrac, destFrac) * 100).toFixed(1)}%)` });
            continue;
          }
          if (config.dryRun) {
            actions.push({ flight: labelOf(row), skipped: "[dry-run] would count clear check" });
            continue;
          }
          const streak = await recordClearCheck(row.id);
          if (streak >= EXPOSURE_CLEAR_STREAK) {
            const outcome = await reviveRoute(chainConfig, asRoute(row), "exposure", "cron:revive");
            actions.push({ flight: labelOf(row), transition: outcome });
          } else {
            actions.push({ flight: labelOf(row), skipped: `eased — clear check ${streak}/${EXPOSURE_CLEAR_STREAK} (hysteresis)` });
          }
        }
      } catch (err) {
        console.error(`[revive] exposure re-check failed — untouched this run: ${err}`);
        actions.push({ flight: "-/exposure", error: String(err) });
      }
    }

    // ── pricing + admin — not ours ─────────────────────────────────────
    for (const row of open.filter((r) => r.cause === "pricing")) {
      actions.push({ flight: labelOf(row), skipped: "owned by the monthly reprice run" });
    }
    for (const row of open.filter((r) => r.cause === "admin")) {
      actions.push({ flight: labelOf(row), skipped: "admin hold — never auto-revived" });
    }

    return done(true);
  } catch (err) {
    console.error(`[revive] Fatal error: ${err}`);
    return done(false, String(err));
  }
}
