import { AgentClient } from "../agent_client";
import { WeatherClient } from "../weather_client";
import {
  classifyForecast,
  combineSeverity,
  clampPremium,
  expectedLossPremiumUnits,
  type WeatherSeverity,
} from "../route_rules";
import { loadRoutesConfig, fileTerms } from "../routes_config";
import { toIata } from "../airline_codes";
import type { RunLogEntry, FetcherAction } from "../types";
import type { GovConfig } from "../governance/config";
import { getDb } from "../governance/db";
import type { RouteRow, SignalRow } from "../governance/model";

/**
 * route_agent (daily) — ML pricing + forecast COLLECTOR.
 *
 * Absorbed into the reconciler architecture (2026-07-27): this job no
 * longer touches the chain. It was the last un-audited actor (direct
 * disable/enable/update_route_terms via hand-rolled helpers, no
 * actions_log); now it writes FACTS and the reconciler — the single
 * audited actor — applies them within its rails:
 *
 * - `pricing` signal (severity info, route-scoped, 26h expiry): the ML
 *   baseline premium from the Render XGBoost service, clamped to the
 *   rails. The reconciler uses it as the premium ANCHOR (multipliers
 *   stack on top; base falls back to the DB row / file defaults when the
 *   signal is absent or expired — an unreachable model degrades to
 *   admin-set terms, never blocks).
 * - `weather` signal (elevated/severe, route-scoped, 26h expiry): the
 *   Open-Meteo forecast verdict for origin+destination (worst of the
 *   two). severe → the reconciler pauses the route; elevated → premium
 *   multiplier. Forecast-based and route-scoped — complements
 *   gov_signals' live airport-delay feed (airport-scoped, AeroAPI).
 *
 * Signals are source-owned (refresh / severity-change reinsert / clear
 * when conditions end) and self-expire, so a dead agent cannot pin
 * prices or pauses. GOV_DRY_RUN logs decisions and writes nothing.
 *
 * Prediction service `/predict` schema: `dep_time_hhmm` and
 * `distance_mi` are optional (service defaults noon / 1000 mi) and sent
 * when the DB route row carries them (filled by gov_onboard/admin) —
 * departure time especially moves the prediction. The service returns
 * only p_covered; premium = expectedLossPremiumUnits(p, payoff) clamped
 * to the rails, all computed here.
 */

const ACTOR_ML = "agent:ml";
const ACTOR_WEATHER = "agent:openmeteo";
const EXPIRY_SECS = 26 * 3600; // daily cadence + margin

export async function run(config: GovConfig): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  const done = (success: boolean, error?: string): RunLogEntry => ({
    timestamp: new Date().toISOString(),
    job: "route_agent",
    duration_ms: Date.now() - start,
    success,
    ...(error ? { error } : {}),
    actions,
  });

  try {
    const routesConfig = loadRoutesConfig();
    const enabled = routesConfig.routes.filter((r) => r.enabled);

    const agent = process.env.AGENT_BASE_URL
      ? new AgentClient(process.env.AGENT_BASE_URL, process.env.AGENT_TOKEN || undefined)
      : null;
    const weather = new WeatherClient(
      process.env.WEATHER_BASE_URL ?? "https://api.open-meteo.com/v1/forecast",
      routesConfig.saleHorizonDays
    );

    const sql = getDb();

    // DB route rows: schedule/distance for the ML request when present.
    const dbRoutes = (await sql`select * from routes`) as unknown as RouteRow[];
    const dbByKey = new Map(dbRoutes.map((r) => [`${r.flight_id}|${r.origin}|${r.dest}`, r]));

    // Signals this agent owns.
    const owned = (await sql`
      select * from signals
      where source in (${ACTOR_ML}, ${ACTOR_WEATHER}) and cleared_at is null
    `) as unknown as SignalRow[];
    const ownedBy = (source: string, r: { flight_id: string; origin: string; destination: string }) =>
      owned.find(
        (s) =>
          s.source === source &&
          s.flight_id === r.flight_id &&
          s.origin === r.origin &&
          s.dest === r.destination
      );

    const expiresAt = new Date(Date.now() + EXPIRY_SECS * 1000).toISOString();

    // Model date features: tomorrow (the first insurable day).
    const tomorrow = new Date(Date.now() + 86_400_000);
    const month = tomorrow.getUTCMonth() + 1;
    const dayOfMonth = tomorrow.getUTCDate();
    const dayOfWeek = ((tomorrow.getUTCDay() + 6) % 7) + 1; // Mon=1..Sun=7

    // Forecast cache per airport (one Open-Meteo call per airport, not per route).
    const forecastCache = new Map<string, Awaited<ReturnType<WeatherClient["getForecast"]>>>();
    const getForecast = async (iata: string) => {
      if (!forecastCache.has(iata)) forecastCache.set(iata, await weather.getForecast(iata));
      return forecastCache.get(iata)!;
    };

    for (const route of enabled) {
      const label = `${route.flight_id} ${route.origin}→${route.destination}`;
      try {
        const terms = fileTerms(routesConfig, route);
        const dbRow = dbByKey.get(`${route.flight_id}|${route.origin}|${route.destination}`);

        // ── 1. ML pricing anchor → `pricing` signal ────────────────────
        // The prediction service is insurance-blind (returns only the
        // calibrated covered-event probability); the expected-loss math
        // and rails clamping happen HERE, protocol-side.
        let anchor: bigint | null = null;
        let pDelay: number | null = null;
        // The model only knows IATA carrier codes — an unconverted code
        // would silently predict from the "unknown carrier" bucket, so an
        // untracked code skips the ML anchor entirely (fail loud).
        const iataCarrier = toIata(route.carrier);
        if (agent && !iataCarrier) {
          console.warn(`[route-agent] ${label}: untracked carrier code "${route.carrier}" — ML anchor skipped`);
        }
        if (agent && iataCarrier) {
          const p = await agent.predict(
            {
              carrier: iataCarrier,
              origin: route.origin,
              dest: route.destination,
              month,
              day_of_month: dayOfMonth,
              day_of_week: dayOfWeek,
              ...(dbRow?.sched_dep_local
                ? { dep_time_hhmm: Number(dbRow.sched_dep_local.slice(0, 5).replace(":", "")) }
                : {}),
              ...(dbRow?.distance_mi != null ? { distance_mi: Number(dbRow.distance_mi) } : {}),
            },
            label
          );
          if (p !== null) {
            anchor = clampPremium(expectedLossPremiumUnits(p, terms.payoff), null, routesConfig.rails);
            pDelay = p;
          }
        }

        const existingPricing = ownedBy(ACTOR_ML, route);
        if (anchor !== null) {
          if (config.dryRun) {
            actions.push({ flight: label, skipped: `[dry-run] pricing anchor ${anchor} (p=${pDelay?.toFixed(3)})` });
          } else if (existingPricing) {
            await sql`
              update signals
              set payload = ${sql.json({ anchor_units: anchor.toString(), p_delay: pDelay })},
                  expires_at = ${expiresAt}
              where id = ${existingPricing.id}
            `;
          } else {
            await sql`
              insert into signals (type, scope_kind, flight_id, origin, dest, severity, payload, source, expires_at)
              values ('pricing', 'route', ${route.flight_id}, ${route.origin}, ${route.destination},
                      'info', ${sql.json({ anchor_units: anchor.toString(), p_delay: pDelay })},
                      ${ACTOR_ML}, ${expiresAt})
            `;
            actions.push({ flight: label, transition: `pricing anchor opened (${anchor})` });
          }
        } else if (existingPricing && !config.dryRun) {
          // Model unreachable/refused: clear our anchor so pricing falls
          // back to the admin base rather than an ever-staler ML figure.
          await sql`update signals set cleared_at = now() where id = ${existingPricing.id}`;
          actions.push({ flight: label, transition: "pricing anchor cleared (no ML)" });
        }

        // ── 2. Forecast verdict → `weather` signal ─────────────────────
        const [o, d] = await Promise.all([getForecast(route.origin), getForecast(route.destination)]);
        const severity: WeatherSeverity = combineSeverity(classifyForecast(o), classifyForecast(d));

        const existingWeather = ownedBy(ACTOR_WEATHER, route);
        if (severity === "ok") {
          if (existingWeather && !config.dryRun) {
            await sql`update signals set cleared_at = now() where id = ${existingWeather.id}`;
            actions.push({ flight: label, transition: "forecast signal cleared (ok)" });
          }
        } else if (config.dryRun) {
          actions.push({ flight: label, skipped: `[dry-run] forecast ${severity}` });
        } else if (existingWeather && existingWeather.severity === severity) {
          await sql`update signals set expires_at = ${expiresAt} where id = ${existingWeather.id}`;
        } else {
          if (existingWeather) {
            await sql`update signals set cleared_at = now() where id = ${existingWeather.id}`;
          }
          await sql`
            insert into signals (type, scope_kind, flight_id, origin, dest, severity, payload, source, expires_at)
            values ('weather', 'route', ${route.flight_id}, ${route.origin}, ${route.destination},
                    ${severity}, ${sql.json({ basis: "open-meteo forecast" })}, ${ACTOR_WEATHER}, ${expiresAt})
          `;
          actions.push({ flight: label, transition: `forecast signal ${severity}` });
        }
      } catch (err) {
        console.error(`[route-agent] ${label}: Error — ${err}. Will retry next run.`);
        actions.push({ flight: label, error: String(err) });
      }
    }

    console.log(`[route-agent] Done. ${actions.length} change(s) across ${enabled.length} route(s).`);
    return done(true);
  } catch (err) {
    console.error(`[route-agent] Fatal error: ${err}`);
    return done(false, String(err));
  }
}
