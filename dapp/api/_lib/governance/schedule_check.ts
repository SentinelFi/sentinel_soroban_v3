import { AeroApiClient } from "../aeroapi_client";
import { cachedFetch } from "../aeroapi_cache";
import { AIRPORTS } from "../airports";
import type { RunLogEntry, FetcherAction } from "../types";
import type { GovConfig } from "./config";
import { getDb } from "./db";
import type { RouteRow, SignalRow } from "./model";

/**
 * gov_schedule_check — the schedule-drift detector (daily; the last of the
 * planned governance signal writers).
 *
 * For every ACTIVE DB route, samples the published schedule over the far
 * window (SAME pair-batched chunks and cache keys as the sale authorizer —
 * when the authorizer already fetched a chunk today, this job costs ZERO
 * extra API calls) and:
 *
 * 1. FILLS canonical schedule columns when NULL: modal scheduled dep/arr
 *    time-of-day (stored as UTC wall-clock, tz columns = 'UTC' — honest,
 *    and the ML dep_time_hhmm feature derives from it) and great-circle
 *    distance_mi from the airports map — completing the fields the Render
 *    pricing model requires.
 * 2. DETECTS drift against the stored canonical schedule:
 *    - retimed: modal published departure differs ≥ DRIFT_MIN minutes →
 *      `schedule_drift` signal, severity ELEVATED (premium multiplier —
 *      a retimed flight's risk profile moved; admin re-verifies terms and
 *      updates the stored schedule to resolve);
 *    - dropped: the flight appears on ZERO sampled days → severity SEVERE
 *      (the reconciler pauses the route — nothing to sell).
 *    Signals are source-owned + self-expiring (refresh while the condition
 *    persists, clear when it ends), same lifecycle as every collector.
 *
 * Facts only — never touches the chain. GOV_DRY_RUN logs and writes
 * nothing.
 */

export const SIGNAL_SOURCE = "check:schedule";
const EXPIRY_SECS = 26 * 3600;
const NEAR_WINDOW_DAYS = 2; // mirror the authorizer's grid for cache-key reuse
const SCHEDULE_CHUNK_DAYS = 20;
const SCHEDULE_CACHE_TTL_SECS = 24 * 3600;
/** Departure retiming that counts as drift. */
export const DRIFT_MIN_MINUTES = 45;

/** Great-circle distance in statute miles (haversine). */
export function distanceMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Modal (most frequent) value; ties → earliest. */
export function modal(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
}

/** Minutes between two 'HH:MM' wall-clock times, shortest way around. */
export function clockDeltaMinutes(a: string, b: string): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let d = Math.abs(toMin(a) - toMin(b));
  if (d > 720) d = 1440 - d; // wrap midnight
  return d;
}

export async function run(config: GovConfig): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  const done = (success: boolean, error?: string): RunLogEntry => ({
    timestamp: new Date().toISOString(),
    job: "gov_schedule_check",
    duration_ms: Date.now() - start,
    success,
    ...(error ? { error } : {}),
    actions,
  });

  try {
    const aero = new AeroApiClient({
      aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "https://aeroapi.flightaware.com/aeroapi",
      aeroApiKey: process.env.AEROAPI_KEY ?? "",
    });
    const sql = getDb();

    const routes = (await sql`select * from routes where status = 'active'`) as unknown as RouteRow[];
    if (routes.length === 0) {
      console.log("[schedule-check] No active routes.");
      return done(true);
    }

    const owned = (await sql`
      select * from signals where source = ${SIGNAL_SOURCE} and cleared_at is null
    `) as unknown as SignalRow[];
    const ownedFor = (r: RouteRow) =>
      owned.find((s) => s.flight_id === r.flight_id && s.origin === r.origin && s.dest === r.dest);

    // ── Pair-batched sampled schedules (authorizer-aligned cache keys) ──
    const horizonDays = Number(process.env.SALE_AUTH_HORIZON_DAYS) > 0
      ? Number(process.env.SALE_AUTH_HORIZON_DAYS)
      : NEAR_WINDOW_DAYS + SCHEDULE_CHUNK_DAYS; // sample ~3 weeks by default
    const nowSecs = Math.floor(Date.now() / 1000);
    const todayIndex = Math.floor(nowSecs / 86_400);
    const dayStr = (i: number) => new Date(i * 86_400_000).toISOString().slice(0, 10);

    // rows per flight: { day, dep 'HH:MM', arr 'HH:MM' }
    const perFlight = new Map<string, Array<{ day: string; dep: string; arr: string }>>();
    const pairs = new Map<string, Set<string>>();
    for (const r of routes) {
      const key = `${r.origin}|${r.dest}`;
      const set = pairs.get(key) ?? new Set();
      set.add(r.flight_id);
      pairs.set(key, set);
    }
    let sampledDays = 0;
    // Pairs with ANY failed chunk: their routes get NO drift decisions this
    // run — "the API couldn't answer" must never read as "dropped from the
    // schedule" (a quota outage would otherwise severe-signal the entire
    // fleet). Existing signals stay untouched and self-expire.
    const failedPairs = new Set<string>();
    for (const [pairKey, fids] of pairs) {
      const [origin, destination] = pairKey.split("|");
      let chunkStart = todayIndex + NEAR_WINDOW_DAYS + 1;
      const lastDay = todayIndex + horizonDays;
      while (chunkStart <= lastDay) {
        const chunkEnd = Math.min(chunkStart + SCHEDULE_CHUNK_DAYS - 1, lastDay);
        const startStr = dayStr(chunkStart);
        const endStr = dayStr(chunkEnd + 1);
        sampledDays = Math.max(sampledDays, chunkEnd - (todayIndex + NEAR_WINDOW_DAYS));
        const schedules = await cachedFetch(
          `sched|${origin}|${destination}|${startStr}|${endStr}`,
          SCHEDULE_CACHE_TTL_SECS,
          () => aero.getSchedules(startStr, endStr, { origin, destination })
        );
        // A truthy links.next means pagination did NOT complete (quota cut
        // or cursor limit) — the row set under-counts, and an under-count
        // must read as "couldn't verify", never as "dropped".
        if (!schedules || schedules.links?.next) {
          failedPairs.add(pairKey);
        }
        for (const entry of schedules?.scheduled ?? []) {
          const ident = entry.actual_ident ?? entry.ident;
          if (!fids.has(ident)) continue;
          const day = (entry.scheduled_out ?? "").slice(0, 10);
          const dep = (entry.scheduled_out ?? "").slice(11, 16);
          const arr = (entry.scheduled_in ?? "").slice(11, 16);
          if (!day || !dep) continue;
          const list = perFlight.get(ident) ?? [];
          list.push({ day, dep, arr });
          perFlight.set(ident, list);
        }
        chunkStart = chunkEnd + 1;
      }
    }

    // ── Per-route: fill + drift ────────────────────────────────────────
    for (const route of routes) {
      const label = `${route.flight_id} ${route.origin}→${route.dest}`;
      try {
        if (failedPairs.has(`${route.origin}|${route.dest}`)) {
          continue; // couldn't verify — no drift decision this run
        }
        const samples = perFlight.get(route.flight_id) ?? [];
        const existing = ownedFor(route);
        const expiresAt = new Date(Date.now() + EXPIRY_SECS * 1000).toISOString();

        // Dropped from the published schedule entirely → severe.
        if (samples.length === 0) {
          if (config.dryRun) {
            actions.push({ flight: label, skipped: "[dry-run] dropped from schedule (severe)" });
            continue;
          }
          if (existing && existing.severity === "severe") {
            await sql`update signals set expires_at = ${expiresAt} where id = ${existing.id}`;
          } else {
            if (existing) await sql`update signals set cleared_at = now() where id = ${existing.id}`;
            await sql`
              insert into signals (type, scope_kind, flight_id, origin, dest, severity, payload, source, expires_at)
              values ('schedule_drift', 'route', ${route.flight_id}, ${route.origin}, ${route.dest},
                      'severe', ${sql.json({ reason: "dropped", sampled_days: sampledDays })},
                      ${SIGNAL_SOURCE}, ${expiresAt})
            `;
            actions.push({ flight: label, transition: "schedule_drift severe (dropped from schedule)" });
          }
          continue;
        }

        const dep = modal(samples.map((s) => s.dep))!;
        const arr = modal(samples.map((s) => s.arr).filter(Boolean));

        // Fill canonical columns when NULL (never clobber admin values).
        const o = AIRPORTS[route.origin];
        const d = AIRPORTS[route.dest];
        const dist = o && d ? distanceMiles(o, d) : null;
        if (!config.dryRun && (route.sched_dep_local === null || (route.distance_mi === null && dist !== null))) {
          await sql`
            update routes set
              sched_dep_local = coalesce(sched_dep_local, ${dep + ":00"}::time),
              sched_arr_local = coalesce(sched_arr_local, ${arr ? arr + ":00" : null}::time),
              dep_tz = coalesce(dep_tz, 'UTC'),
              arr_tz = coalesce(arr_tz, 'UTC'),
              distance_mi = coalesce(distance_mi, ${dist}),
              updated_at = now()
            where id = ${route.id}
          `;
          actions.push({ flight: label, transition: `schedule filled (dep ${dep}Z${dist ? `, ${dist}mi` : ""})` });
        }

        // Drift vs the stored canonical departure.
        const stored = route.sched_dep_local?.slice(0, 5) ?? null;
        const delta = stored ? clockDeltaMinutes(stored, dep) : 0;
        if (stored && delta >= DRIFT_MIN_MINUTES) {
          if (config.dryRun) {
            actions.push({ flight: label, skipped: `[dry-run] drift ${stored}→${dep} (${delta}m)` });
          } else if (existing && existing.severity === "elevated") {
            await sql`
              update signals set expires_at = ${expiresAt},
                payload = ${sql.json({ reason: "retimed", stored, published: dep, delta_min: delta })}
              where id = ${existing.id}
            `;
          } else {
            if (existing) await sql`update signals set cleared_at = now() where id = ${existing.id}`;
            await sql`
              insert into signals (type, scope_kind, flight_id, origin, dest, severity, payload, source, expires_at)
              values ('schedule_drift', 'route', ${route.flight_id}, ${route.origin}, ${route.dest},
                      'elevated', ${sql.json({ reason: "retimed", stored, published: dep, delta_min: delta })},
                      ${SIGNAL_SOURCE}, ${expiresAt})
            `;
            actions.push({ flight: label, transition: `schedule_drift elevated (${stored} → ${dep}, ${delta}m)` });
          }
        } else if (existing && !config.dryRun) {
          await sql`update signals set cleared_at = now() where id = ${existing.id}`;
          actions.push({ flight: label, transition: "schedule_drift cleared" });
        }
      } catch (err) {
        console.error(`[schedule-check] ${label}: ${err}`);
        actions.push({ flight: label, error: String(err) });
      }
    }

    console.log(`[schedule-check] Done. ${actions.length} change(s) across ${routes.length} route(s).`);
    return done(true);
  } catch (err) {
    console.error(`[schedule-check] Fatal error: ${err}`);
    return done(false, String(err));
  }
}
