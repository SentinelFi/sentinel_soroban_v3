import {
  classifyForecast,
  clampPremium,
  combineSeverity,
  isExtremeForecast,
  weatherSurchargeUnits,
} from "../route_rules.js";
import { baseUnitsToUsdc, fileTerms, loadRoutesConfig } from "../routes_config.js";
import { WeatherClient } from "../weather_client.js";
import type { FetcherAction, RunLogEntry } from "../types.js";
import type { GovConfig } from "../governance/config.js";
import { GovSubmitter } from "../governance/submitter.js";
import { pauseRoute, type GovChainConfig } from "../governance/interventions.js";

/**
 * weather (every ~2h) — the STATELESS storm surcharge loop.
 *
 * The 2026-07-30 simplification: no DB, no signals, no reconciler, no
 * multipliers, no hysteresis machinery. One pass is the whole system:
 *
 *   for each enabled fleet route:
 *     severity = worst(origin, dest) over the next weather_horizon_days
 *                (default 3 — beyond that storm forecasts have no skill,
 *                and neither do buyers, so there is nothing to price)
 *     target   = fleet-file base premium + surcharge (elevated +$2,
 *                severe +$10; whole dollars), clamped to rails.premiumMax
 *     on-chain premium ≠ target → update_route_terms (premium only)
 *
 * Properties that fall out of this shape:
 *   - Raise AND clear are the same comparison — calm forecast makes
 *     target = base, so surcharges clear on the next pass.
 *   - Stateless + idempotent: desired state is recomputed from the fleet
 *     file + live forecast every pass; a crashed run heals on the next.
 *   - Self-correcting after the monthly repricing ritual (the fleet file
 *     IS the base the surcharge builds on).
 *   - The term-snapshot rule means a surcharge only affects flight-date
 *     buckets whose first purchase comes after it — never repricing
 *     anyone who already bought.
 *
 * One exception above "severe" (2026-08-01, user decision): an EXTREME
 * forecast — hurricane-force gusts / blizzard-scale snow at either
 * airport (route_rules.isExtremeForecast) — is not priced, it is paused:
 * a `weather` intervention opens through the shared executor, and the
 * hourly revive cron lifts it the moment the forecast drops back below
 * extreme. Severe still just adds the +$10 surcharge and keeps selling.
 *
 * Forecasts fail open: an unreachable Open-Meteo or unknown airport is
 * "ok" (no surcharge, no pause), never an error — real insurability is
 * still gated by the JIT sale-auth endpoint (AeroAPI, fail-closed).
 */

const ACTOR = "cron:weather";

export async function run(config: GovConfig): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];

  try {
    const routesConfig = loadRoutesConfig();
    const enabled = routesConfig.routes.filter((r) => r.enabled);

    const weather = new WeatherClient(
      process.env.WEATHER_BASE_URL ?? "https://api.open-meteo.com/v1/forecast",
      routesConfig.weatherHorizonDays
    );
    const submitter = new GovSubmitter({
      rpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      adminSecretKey: config.govAdminSecretKey,
      actor: ACTOR,
    });

    // One forecast per airport, not per route.
    const forecastCache = new Map<string, Awaited<ReturnType<WeatherClient["getForecast"]>>>();
    const getForecast = async (iata: string) => {
      if (!forecastCache.has(iata)) forecastCache.set(iata, await weather.getForecast(iata));
      return forecastCache.get(iata)!;
    };

    // Fleet-scale time budget (2026-08-04, 1,069 routes): the platform
    // hard-caps this function at 300s (Pro without Fluid ignores a higher
    // maxDuration), and a full-fleet chain-read sweep flirts with that cap
    // whenever the public RPC slows. So each pass processes:
    //   1. EVERY route touching an airport whose forecast is non-calm —
    //      storm pricing/pausing never waits; and
    //   2. a rotating quarter of the fleet (stable hash × 2h slot) — the
    //      calm-weather hygiene slice that clears stale surcharges. Worst
    //      case a stale surcharge outlives the storm by ≤8h, bounded and
    //      buyer-favorable-priced (they overpay a known flat surcharge,
    //      never underpay).
    // Forecasts stay per-airport-cached (≈30 fetches) — the expensive part
    // is the per-route on-chain read, so THAT is what the shard limits.
    const forecastByAirport = new Map<string, Awaited<ReturnType<typeof getForecast>>>();
    for (const route of enabled) {
      for (const iata of [route.origin, route.destination]) {
        if (!forecastByAirport.has(iata)) forecastByAirport.set(iata, await getForecast(iata));
      }
    }
    const calmAirports = new Set(
      [...forecastByAirport.entries()]
        .filter(([, f]) => !isExtremeForecast(f) && classifyForecast(f) === "ok")
        .map(([iata]) => iata)
    );
    const SHARDS = 4;
    const shardIdx = Math.floor(Date.now() / (2 * 3600 * 1000)) % SHARDS;
    const inShard = (r: (typeof enabled)[number]): boolean => {
      const s = `${r.flight_id}|${r.origin}|${r.destination}`;
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return ((h >>> 0) % SHARDS) === shardIdx;
    };
    const toProcess = enabled.filter(
      (r) => !calmAirports.has(r.origin) || !calmAirports.has(r.destination) || inShard(r)
    );

    console.log(
      `[weather] ${enabled.length} enabled route(s), ${routesConfig.weatherHorizonDays}d horizon — ` +
        `processing ${toProcess.length} (storm-affected + shard ${shardIdx + 1}/${SHARDS})` +
        (config.dryRun ? " [DRY RUN]" : "")
    );

    // Pre-read this pass's on-chain statuses in 20-wide chunks (the same
    // RPC-friendly width the board scan used) — sequential per-route
    // reads were ~7min at full fleet scale.
    const STATUS_CHUNK = 20;
    const statusByKey = new Map<string, Awaited<ReturnType<GovSubmitter["readStatus"]>> | null>();
    for (let i = 0; i < toProcess.length; i += STATUS_CHUNK) {
      await Promise.all(
        toProcess.slice(i, i + STATUS_CHUNK).map(async (route) => {
          const mapKey = `${route.flight_id}|${route.origin}|${route.destination}`;
          try {
            statusByKey.set(
              mapKey,
              await submitter.readStatus({
                flightId: route.flight_id,
                origin: route.origin,
                dest: route.destination,
              })
            );
          } catch {
            statusByKey.set(mapKey, null); // read failed — skip below, next pass heals
          }
        })
      );
    }

    let surcharged = 0;
    let cleared = 0;
    for (const route of toProcess) {
      const label = `${route.flight_id} ${route.origin}→${route.destination}`;
      try {
        const [o, d] = [await getForecast(route.origin), await getForecast(route.destination)];

        // EXTREME → pause, don't price. The revive cron re-opens the
        // route the hour the forecast clears.
        if (isExtremeForecast(o) || isExtremeForecast(d)) {
          const evidence = {
            origin: { iata: route.origin, gust_kmh: o?.maxWindGustKmh, snow_cm: o?.totalSnowfallCm },
            dest: { iata: route.destination, gust_kmh: d?.maxWindGustKmh, snow_cm: d?.totalSnowfallCm },
          };
          if (config.dryRun) {
            actions.push({ flight: label, skipped: "[dry-run] EXTREME forecast — would pause" });
            continue;
          }
          const chainConfig: GovChainConfig = {
            stellarRpcUrl: config.stellarRpcUrl,
            networkPassphrase: config.networkPassphrase,
            governanceId: config.governanceId,
            governanceAdminSecretKey: config.govAdminSecretKey,
          };
          const result = await pauseRoute(chainConfig, route, "weather", evidence, ACTOR);
          actions.push({ flight: label, transition: `EXTREME forecast — ${result.outcome}` });
          continue;
        }

        const severity = combineSeverity(classifyForecast(o), classifyForecast(d));

        const base = fileTerms(routesConfig, route).premium;
        const target = clampPremium(base + weatherSurchargeUnits(severity, routesConfig.rails), routesConfig.rails);

        const key = { flightId: route.flight_id, origin: route.origin, dest: route.destination };
        const onChain = statusByKey.get(`${route.flight_id}|${route.origin}|${route.destination}`);
        if (!onChain) {
          actions.push({ flight: label, skipped: "on-chain status read failed — next pass heals" });
          continue;
        }
        if (onChain.status !== "Active") {
          actions.push({ flight: label, skipped: `on-chain ${onChain.status} — weather only reprices active routes` });
          continue;
        }
        const current = onChain.terms?.premium ?? null;
        if (current === target) {
          actions.push({ flight: label, skipped: `at target $${baseUnitsToUsdc(target)} (${severity})` });
          continue;
        }

        if (config.dryRun) {
          actions.push({ flight: label, skipped: `[dry-run] ${severity}: $${current !== null ? baseUnitsToUsdc(current) : "?"} → $${baseUnitsToUsdc(target)}` });
          continue;
        }
        await submitter.updateTerms(key, target, "keep", "keep");
        if (target > base) surcharged++;
        else cleared++;
        actions.push({
          flight: label,
          transition: `${severity}: premium $${current !== null ? baseUnitsToUsdc(current) : "?"} → $${baseUnitsToUsdc(target)}`,
        });
      } catch (err) {
        console.error(`[weather] ${label}: Error — ${err}. Next pass heals.`);
        actions.push({ flight: label, error: String(err) });
      }
    }

    console.log(`[weather] done: ${surcharged} surcharged, ${cleared} cleared/adjusted`);
    return {
      timestamp: new Date().toISOString(),
      job: "weather",
      duration_ms: Date.now() - start,
      success: true,
      actions,
    };
  } catch (err) {
    console.error(`[weather] Fatal error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "weather",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
      actions,
    };
  }
}
