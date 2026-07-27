import { AeroApiClient, type AeroApiAirportDelay } from "../aeroapi_client";
import { loadRoutesConfig } from "../routes_config";
import type { RunLogEntry, FetcherAction } from "../types";
import type { GovConfig } from "./config";
import { getDb } from "./db";
import type { SignalRow } from "./model";

/**
 * gov_signals — airport-delay signal collector (hourly, before the reconciler).
 *
 * ONE AeroAPI call (`GET /airports/delays`) returns every airport currently
 * under a delay condition, with a category ("weather", "traffic", ...), a
 * severity color and a delay duration. This collector projects that feed
 * onto the governance signals table for the airports our enabled routes
 * actually touch:
 *
 *   color "red"    → severity "severe"   → the reconciler pauses routes
 *                                          touching the airport
 *   color "yellow" → severity "elevated" → premium multiplier stacks
 *   anything else  → ignored (informational)
 *
 * Signals are FACTS — this job never touches the chain. The reconciler
 * (hourly at :10, right after this job at :05) is the only actor.
 *
 * Lifecycle per airport (source = SIGNAL_SOURCE):
 * - new delay          → insert one signal per scope (origin + dest — an
 *   airport affects routes in both directions; signalMatchesRoute matches
 *   origin-scope against route.origin and dest-scope against route.dest);
 * - still delayed      → refresh expires_at (and severity change =
 *   clear + re-insert so the audit trail keeps both levels);
 * - no longer delayed  → cleared_at = now (starts the reconciler's
 *   re-enable hysteresis clock);
 * - collector dies     → signals self-expire at expires_at (EXPIRY_SECS),
 *   so a dead collector cannot pin routes paused forever; the staleness is
 *   visible on the /admin jobs board well before that.
 * - the API call fails → NO changes (a transient AeroAPI error must not
 *   clear real weather pauses); run reports success=false for ops.
 *
 * Schema note: the signals.type CHECK allows
 * (weather|geopolitical|exposure|schedule_drift|manual), so all airport
 * delay categories are written as type "weather" with the true category in
 * payload.category. Revisit with an 'ops' type if the distinction ever
 * drives different rules — today only severity is load-bearing.
 *
 * GOV_DRY_RUN=true: compute + log the desired signal set, write nothing.
 */

export const SIGNAL_SOURCE = "aeroapi:airport-delays";
const EXPIRY_SECS = 6 * 3600; // self-expiry safety if the collector dies

export interface AirportDelaySignalSpec {
  /** IATA-style code as used in the routes file (JFK, not KJFK). */
  airport: string;
  severity: "elevated" | "severe";
  scope_kind: "origin" | "dest";
  payload: {
    airport_feed_code: string;
    category: string;
    color: string;
    delay_secs: number;
  };
}

/**
 * Normalize an AeroAPI airport code to the IATA-style code the routes file
 * uses. US ICAO codes are K + IATA ("KJFK" → "JFK"); anything else is
 * returned as-is (international airports need a real ICAO↔IATA map — until
 * then their delays simply won't match a route airport, which fails safe).
 */
export function feedCodeToIata(code: string): string {
  return /^K[A-Z]{3}$/.test(code) ? code.slice(1) : code;
}

/**
 * PURE projection: airport-delay feed → desired signal specs for the
 * airports in play. Exported for tests.
 */
export function computeDesiredSignals(
  delays: AeroApiAirportDelay[],
  routeAirports: Set<string>
): AirportDelaySignalSpec[] {
  const specs: AirportDelaySignalSpec[] = [];
  for (const delay of delays) {
    const severity =
      delay.color === "red" ? "severe" : delay.color === "yellow" ? "elevated" : null;
    if (!severity) continue;

    const iata = feedCodeToIata(delay.airport);
    if (!routeAirports.has(iata)) continue;

    for (const scope_kind of ["origin", "dest"] as const) {
      specs.push({
        airport: iata,
        severity,
        scope_kind,
        payload: {
          airport_feed_code: delay.airport,
          category: delay.category,
          color: delay.color,
          delay_secs: delay.delay_secs,
        },
      });
    }
  }
  return specs;
}

/** Airports (IATA) touched by the enabled routes. */
export function enabledRouteAirports(): Set<string> {
  const routesConfig = loadRoutesConfig();
  const airports = new Set<string>();
  for (const r of routesConfig.routes) {
    if (!r.enabled) continue;
    airports.add(r.origin);
    airports.add(r.destination);
  }
  return airports;
}

export async function run(config: GovConfig): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];

  try {
    // AeroAPI env is read directly (GovConfig carries no oracle/keeper
    // secrets by design; the API key is not one of them but lives with the
    // other AeroAPI settings in the base env).
    const aero = new AeroApiClient({
      aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "https://aeroapi.flightaware.com/aeroapi",
      aeroApiKey: process.env.AEROAPI_KEY ?? "",
    });

    const routeAirports = enabledRouteAirports();
    if (routeAirports.size === 0) {
      console.log("[gov-signals] No enabled routes — nothing to watch.");
      return done(start, actions, true);
    }

    const feed = await aero.getAirportDelays();
    if (!feed) {
      // Transient API failure must not clear live weather pauses — take no
      // action and surface the failed run.
      console.error("[gov-signals] /airports/delays unavailable — no signal changes this run.");
      return { ...done(start, actions, false), error: "AeroAPI /airports/delays unavailable" };
    }

    const desired = computeDesiredSignals(feed.delays ?? [], routeAirports);
    console.log(
      `[gov-signals] ${feed.delays?.length ?? 0} delayed airport(s) in feed; ` +
        `${desired.length / 2} relevant to ${routeAirports.size} route airport(s).`
    );

    if (config.dryRun) {
      for (const spec of desired) {
        console.log(`[gov-signals] [dry-run] would ensure ${spec.severity} ${spec.scope_kind}:${spec.airport}`);
        actions.push({ flight: `${spec.airport}/${spec.scope_kind}`, skipped: `[dry-run] ${spec.severity}` });
      }
      return done(start, actions, true);
    }

    const sql = getDb();
    const expiresAt = new Date(Date.now() + EXPIRY_SECS * 1000).toISOString();

    // Active rows this collector owns.
    const active = (await sql`
      select * from signals
      where source = ${SIGNAL_SOURCE} and cleared_at is null
    `) as unknown as SignalRow[];

    const keyOf = (scope: string, airport: string | null) => `${scope}|${airport}`;
    const desiredByKey = new Map(desired.map((s) => [keyOf(s.scope_kind, s.airport), s]));
    const activeByKey = new Map(
      active.map((row) => [keyOf(row.scope_kind, row.scope_kind === "origin" ? row.origin : row.dest), row])
    );

    // Upsert desired signals.
    for (const [key, spec] of desiredByKey) {
      const existing = activeByKey.get(key);
      if (existing && existing.severity === spec.severity) {
        await sql`
          update signals
          set expires_at = ${expiresAt}, payload = ${sql.json(spec.payload as any)}
          where id = ${existing.id}
        `;
        continue; // refreshed, no action-log noise
      }
      if (existing) {
        // Severity changed (yellow ↔ red): close the old fact, open the new
        // one — the audit trail keeps both levels.
        await sql`update signals set cleared_at = now() where id = ${existing.id}`;
        actions.push({ flight: `${spec.airport}/${spec.scope_kind}`, transition: `signal ${existing.severity} → ${spec.severity}` });
      } else {
        actions.push({ flight: `${spec.airport}/${spec.scope_kind}`, transition: `signal opened (${spec.severity}, ${spec.payload.category})` });
      }
      await sql`
        insert into signals (type, scope_kind, origin, dest, severity, payload, source, expires_at)
        values (
          'weather',
          ${spec.scope_kind},
          ${spec.scope_kind === "origin" ? spec.airport : null},
          ${spec.scope_kind === "dest" ? spec.airport : null},
          ${spec.severity},
          ${sql.json(spec.payload as any)},
          ${SIGNAL_SOURCE},
          ${expiresAt}
        )
      `;
    }

    // Clear signals whose airport dropped out of the feed.
    for (const [key, row] of activeByKey) {
      if (desiredByKey.has(key)) continue;
      await sql`update signals set cleared_at = now() where id = ${row.id}`;
      const airport = row.scope_kind === "origin" ? row.origin : row.dest;
      actions.push({ flight: `${airport}/${row.scope_kind}`, transition: "signal cleared (delay ended)" });
    }

    console.log(`[gov-signals] Done. ${actions.length} change(s).`);
    return done(start, actions, true);
  } catch (err) {
    console.error(`[gov-signals] Fatal error: ${err}`);
    return { ...done(start, actions, false), error: String(err) };
  }
}

function done(start: number, actions: FetcherAction[], success: boolean): RunLogEntry {
  return {
    timestamp: new Date().toISOString(),
    job: "gov_signals",
    duration_ms: Date.now() - start,
    success,
    actions,
  };
}
