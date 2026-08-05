import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { loadGovConfig } from "../_lib/governance/config.js";
import {
  pauseRoute,
  reviveRoute,
  type GovChainConfig,
} from "../_lib/governance/interventions.js";
import { classifyForecast, isExtremeForecast } from "../_lib/route_rules.js";
import { loadRoutesConfig, type RouteEntry } from "../_lib/routes_config.js";
import { WeatherClient } from "../_lib/weather_client.js";
import type { DailyForecast } from "../_lib/weather_client.js";

/**
 * Admin API — the AIRPORT view of the fleet.
 *
 * Every automated control in this system reasons per ROUTE, but weather
 * arrives per AIRPORT: a hub under a blizzard is one fact about ~200
 * routes. The weather cron already knows that (it caches one forecast per
 * airport) — it just never shows anyone. This endpoint is that view, plus
 * the manual lever the cron deliberately does not have.
 *
 * GET  → per airport: the CURRENT Open-Meteo verdict through the same
 *        classifiers the weather cron decides with (route_rules
 *        classifyForecast / isExtremeForecast — one source of truth for
 *        "severe", never a second opinion), the raw gust/snow numbers
 *        behind it, and the BLAST RADIUS (how many fleet routes touch the
 *        airport). ~14 distinct airports over 1,069 routes, one forecast
 *        fetch each — never per route. A null forecast (unknown airport /
 *        Open-Meteo down) reports severity "ok" with forecast_ok=false,
 *        the same fail-open posture as the cron.
 * POST → { iata, action: "pause"|"unpause", confirm: true, reason? }:
 *        pause or unpause EVERY route touching that airport, as an
 *        `admin` cause, through the shared interventions executor.
 *
 * The admin cause is deliberate: automated causes are auto-revived when
 * their predicate clears, an `admin` hold never is. A human closes what a
 * human opened (here, or from the interventions board).
 */

// A hub-wide pause is a long SEQUENTIAL burst of on-chain writes; same
// cap as the crons that do the same kind of work.
export const config = { maxDuration: 300 };

const ACTOR_PREFIX = "admin";

/**
 * SAFETY BUDGET for the POST burst. Each route is its own on-chain
 * disable/enable (~7-10s) signed by the ONE shared gov-admin key, so a
 * 200-route hub cannot finish in a single invocation and must not try:
 * blowing the 300s cap mid-burst would leave the fleet half-paused with
 * no report of where it stopped. The run stops at the budget and returns
 * exactly which routes were done and how many are left; re-POSTing
 * continues (pauseRoute/reviveRoute are idempotent — an already-open
 * intervention is refreshed, not duplicated).
 */
const BURST_BUDGET_MS = 240_000;

interface AirportSummary {
  iata: string;
  severity: "ok" | "elevated" | "severe";
  extreme: boolean;
  max_gust_kmh: number | null;
  total_snow_cm: number | null;
  /** BLAST RADIUS: enabled fleet routes with this airport at either end. */
  route_count: number;
  /** False when Open-Meteo gave us nothing (severity then reads "ok"). */
  forecast_ok: boolean;
}

/** Enabled fleet routes touching an airport at either end. */
function routesTouching(routes: RouteEntry[], iata: string): RouteEntry[] {
  return routes.filter((r) => r.origin === iata || r.destination === iata);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const actor = `${ACTOR_PREFIX}:${admin.email}`;

  try {
    const routesConfig = loadRoutesConfig();
    const enabled = routesConfig.routes.filter((r) => r.enabled !== false);

    if (req.method === "GET") {
      // 1. Distinct airports + blast radius, in one pass over the fleet.
      const routeCount = new Map<string, number>();
      for (const r of enabled) {
        for (const iata of new Set([r.origin, r.destination])) {
          routeCount.set(iata, (routeCount.get(iata) ?? 0) + 1);
        }
      }

      // 2. ONE forecast per airport (~14), fetched in parallel. The Map is
      //    the dedupe: two routes sharing an origin share a fetch.
      const weather = new WeatherClient(
        process.env.WEATHER_BASE_URL ?? "https://api.open-meteo.com/v1/forecast",
        routesConfig.weatherHorizonDays,
      );
      const iatas = [...routeCount.keys()].sort();
      const forecasts = new Map<string, DailyForecast | null>(
        await Promise.all(
          iatas.map(
            async (iata) =>
              [iata, await weather.getForecast(iata)] as [string, DailyForecast | null],
          ),
        ),
      );

      // 3. Same verdicts the weather cron acts on — no second opinion.
      const airports: AirportSummary[] = iatas.map((iata) => {
        const f = forecasts.get(iata) ?? null;
        return {
          iata,
          severity: classifyForecast(f),
          extreme: isExtremeForecast(f),
          max_gust_kmh: f ? f.maxWindGustKmh : null,
          total_snow_cm: f ? f.totalSnowfallCm : null,
          route_count: routeCount.get(iata) ?? 0,
          forecast_ok: f !== null,
        };
      });

      res.status(200).json({
        as_of: new Date().toISOString(),
        horizon_days: routesConfig.weatherHorizonDays,
        count: airports.length,
        fleet_routes: enabled.length,
        airports,
      });
      return;
    }

    if (req.method === "POST") {
      const b = (req.body ?? {}) as {
        iata?: string;
        action?: string;
        confirm?: boolean;
        reason?: string;
      };
      const iata = typeof b.iata === "string" ? b.iata.trim().toUpperCase() : "";
      const action = b.action === "pause" || b.action === "unpause" ? b.action : "";
      if (!iata || !action) {
        res.status(400).json({ error: 'expected { iata, action: "pause"|"unpause", confirm: true }' });
        return;
      }

      const affected = routesTouching(enabled, iata);
      if (affected.length === 0) {
        res.status(404).json({ error: `no enabled fleet route touches ${iata}` });
        return;
      }

      // DRY RUN of the destructive kind: without an explicit confirm the
      // request is a QUOTE. Nothing is read from chain, nothing is
      // written, nothing is logged — the operator just learns how big the
      // hammer is before swinging it.
      if (b.confirm !== true) {
        res.status(400).json({
          error: "confirmation required",
          confirm_required: true,
          iata,
          action,
          blast_radius: affected.length,
          routes: affected.map((r) => ({
            flight_id: r.flight_id,
            origin: r.origin,
            dest: r.destination,
          })),
        });
        return;
      }

      const gov = loadGovConfig();
      const chainConfig: GovChainConfig = {
        stellarRpcUrl: gov.stellarRpcUrl,
        networkPassphrase: gov.networkPassphrase,
        governanceId: gov.governanceId,
        governanceAdminSecretKey: gov.govAdminSecretKey,
      };

      if (gov.dryRun) {
        // GOV_DRY_RUN is honored ABOVE the executor: interventions would
        // happily write the ledger row and the chain, so the gate has to
        // be here.
        res.status(200).json({
          ok: true,
          dry_run: true,
          iata,
          action,
          blast_radius: affected.length,
          routes: affected.map((r) => ({
            flight_id: r.flight_id,
            origin: r.origin,
            dest: r.destination,
            outcome: `[dry-run] would ${action}`,
          })),
        });
        return;
      }

      // Unpause needs the ledger to find what to close; reviveRoute
      // queries it unconditionally.
      if (action === "unpause" && !process.env.GOVERNANCE_DB_URL) {
        res.status(503).json({ error: "GOVERNANCE_DB_URL unset — no interventions ledger to close" });
        return;
      }

      // ── the burst ──────────────────────────────────────────────────
      // Deliberately sequential: these all sign with the SAME gov-admin
      // key, and parallel submissions collide on its sequence number
      // (the txBadSeq retry in SorobanClient exists because of exactly
      // that). Slow is the correct speed here.
      const start = Date.now();
      const results: Array<{ flight_id: string; origin: string; dest: string; outcome: string }> = [];
      let deferred = 0;
      const evidence = {
        scope: "airport",
        iata,
        blast_radius: affected.length,
        reason: b.reason ?? `admin ${action} of every route touching ${iata}`,
      };

      for (const r of affected) {
        if (Date.now() - start > BURST_BUDGET_MS) {
          deferred++;
          continue;
        }
        const row = { flight_id: r.flight_id, origin: r.origin, dest: r.destination };
        try {
          const outcome =
            action === "pause"
              ? (await pauseRoute(chainConfig, r, "admin", evidence, actor)).outcome
              : await reviveRoute(chainConfig, r, "admin", actor);
          results.push({ ...row, outcome });
        } catch (err) {
          // One bad route must not abort the burst — record and continue.
          results.push({ ...row, outcome: `error: ${err instanceof Error ? err.message : String(err)}` });
        }
      }

      res.status(200).json({
        ok: true,
        iata,
        action,
        blast_radius: affected.length,
        processed: results.length,
        deferred, // re-POST with the same body to continue (idempotent)
        duration_ms: Date.now() - start,
        routes: results,
      });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
