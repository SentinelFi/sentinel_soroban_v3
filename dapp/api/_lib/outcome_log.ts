import { getDb } from "./governance/db.js";
import { loadRoutesConfig } from "./routes_config.js";
import { WeatherClient } from "./weather_client.js";

/** Exported so read paths (the admin outcomes panel) can guarantee the
 *  table exists without having logged an outcome yet. */
export async function ensureOutcomesTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    create table if not exists flight_outcomes (
      id bigint generated always as identity primary key,
      logged_at timestamptz not null default now(),
      flight_id text not null,
      origin text not null,
      dest text not null,
      flight_date date not null,
      outcome text not null,
      delay_minutes int,
      origin_gust_kmh real,
      origin_snow_cm real,
      origin_precip_prob_pct real,
      origin_wmo_codes int[],
      dest_gust_kmh real,
      dest_snow_cm real,
      dest_precip_prob_pct real,
      dest_wmo_codes int[],
      unique (flight_id, origin, dest, flight_date)
    )
  `;
  // FSA-H01: enable deny-all RLS on this self-created table (see the same
  // note in governance/interventions.ts). New tables default to
  // RLS-disabled and anon holds default grants on the public schema;
  // without this the table is world read/write via PostgREST. Owner
  // (postgres) bypasses RLS, so server-side access is unaffected.
  await sql`alter table flight_outcomes enable row level security`;
}

/**
 * flight_outcomes — THE weather-learnability log (2026-07-30 design):
 * ONE table, ONE row per insured flight-day, written by the fetcher at
 * the moment it attests the final outcome on-chain. Each row pairs what
 * happened (outcome, delay minutes) with the ACTUAL weather at both
 * airports on the flight's local date (Open-Meteo past-date reanalysis —
 * actuals, not forecasts, are what a weather-conditioned model trains
 * on), so "P(covered | gusts ≥ X at origin)" is a single-table query.
 *
 * Deliberately simple:
 *   - insured flights only (whitelisted routes with a written outcome)
 *   - strictly DB-optional and FAIL-OPEN: no GOVERNANCE_DB_URL, a dead
 *     weather API, or a DB hiccup → the attestation proceeds untouched;
 *     at worst a row is missing or has null weather columns
 *   - self-creating table (the governance schema is managed manually in
 *     Supabase; this doesn't warrant a migration ceremony)
 */

export type FlightOutcome = "ontime" | "delayed" | "cancelled" | "diverted";

export interface OutcomeLogEntry {
  flightId: string;
  /** Flight date as unix seconds (UTC midnight, the on-chain key). */
  dateUnix: bigint;
  outcome: FlightOutcome;
  /** Gate-arrival delay in minutes (null for cancelled/diverted). */
  delayMinutes: number | null;
}

// One weather fetch per airport-date across the whole process lifetime.
const pastWeatherCache = new Map<string, Awaited<ReturnType<WeatherClient["getPastDaily"]>>>();

async function pastWeather(
  weather: WeatherClient,
  iata: string,
  dateIso: string
): Promise<{ gust: number | null; snow: number | null; precip: number | null; codes: number[] | null }> {
  const key = `${iata}|${dateIso}`;
  if (!pastWeatherCache.has(key)) pastWeatherCache.set(key, await weather.getPastDaily(iata, dateIso));
  const w = pastWeatherCache.get(key)!;
  return w
    ? { gust: w.maxWindGustKmh, snow: w.totalSnowfallCm, precip: w.maxPrecipProbPct, codes: w.weatherCodes }
    : { gust: null, snow: null, precip: null, codes: null };
}

export async function logFlightOutcome(entry: OutcomeLogEntry): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const routesConfig = loadRoutesConfig();
    const route = routesConfig.routes.find((r) => r.flight_id === entry.flightId);
    if (!route) return; // not an insured fleet flight — nothing to learn from

    const dateIso = new Date(Number(entry.dateUnix) * 1000).toISOString().slice(0, 10);
    const weather = new WeatherClient(
      process.env.WEATHER_BASE_URL ?? "https://api.open-meteo.com/v1/forecast",
      1
    );
    const [o, d] = [
      await pastWeather(weather, route.origin, dateIso),
      await pastWeather(weather, route.destination, dateIso),
    ];

    const sql = getDb();
    await ensureOutcomesTable(sql);
    // OCA-L07: first write wins. The on-chain outcome is forward-only and
    // written once, so a second log for the same key is either an
    // idempotent retry (harmless) or a divergent value that must NOT
    // silently rewrite the ML training log — keep the original and warn.
    const inserted = (await sql`
      insert into flight_outcomes
        (flight_id, origin, dest, flight_date, outcome, delay_minutes,
         origin_gust_kmh, origin_snow_cm, origin_precip_prob_pct, origin_wmo_codes,
         dest_gust_kmh, dest_snow_cm, dest_precip_prob_pct, dest_wmo_codes)
      values
        (${entry.flightId}, ${route.origin}, ${route.destination}, ${dateIso},
         ${entry.outcome}, ${entry.delayMinutes},
         ${o.gust}, ${o.snow}, ${o.precip}, ${o.codes},
         ${d.gust}, ${d.snow}, ${d.precip}, ${d.codes})
      on conflict (flight_id, origin, dest, flight_date) do nothing
      returning outcome
    `) as unknown as unknown[];
    if (inserted.length === 0) {
      const existing = (await sql`
        select outcome, delay_minutes from flight_outcomes
        where flight_id = ${entry.flightId} and origin = ${route.origin}
          and dest = ${route.destination} and flight_date = ${dateIso}
      `) as unknown as Array<{ outcome: string; delay_minutes: number | null }>;
      const prior = existing[0];
      if (prior && (prior.outcome !== entry.outcome || prior.delay_minutes !== entry.delayMinutes)) {
        console.warn(
          `[outcome-log] ${entry.flightId} ${dateIso}: divergent re-log ` +
            `(${entry.outcome}/${entry.delayMinutes}m vs stored ${prior.outcome}/${prior.delay_minutes}m) — ` +
            `keeping the first-written value.`
        );
      }
      return;
    }
    console.log(`[outcome-log] ${entry.flightId} ${dateIso}: ${entry.outcome}${entry.delayMinutes != null ? ` (${entry.delayMinutes}m)` : ""} logged`);
  } catch (err) {
    console.warn(`[outcome-log] failed for ${entry.flightId} (ignored): ${err}`);
  }
}
