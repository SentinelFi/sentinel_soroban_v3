import { AeroApiClient, isConfirmedCancellation } from "./aeroapi_client";
import {
  checkedRecently,
  pauseRoute,
  recordCheck,
  type GovChainConfig,
} from "./governance/interventions";

/**
 * Route guard — the anomaly-triggered cancellation sweep (no cron).
 *
 * Fired by the JIT sale-authorization endpoint the moment a buy attempt
 * hits a cancelled or schedule-vanished flight. It answers one question
 * with exactly TWO AeroAPI calls: "is this route dead for the next
 * 5 days?" —
 *   - days +1..+2: one /flights range call (live tracking — a day is dead
 *     when its instance is a corroborated cancellation or verified absent);
 *   - days +3..+5: one /schedules call for the pair (published timetable —
 *     a day is dead when the flight number no longer appears on it).
 *
 * ALL five days dead → open a `cancellation` intervention (the unified
 * pause ledger, governance/interventions.ts): the route is disabled
 * on-chain through the audited executor, and the hourly revive cron
 * re-enables it once the sweep finds a live day again. Any day alive or
 * unverifiable → no pause; the buy refusal (and per-day tombstones)
 * already protect the vault — the sweep result is still recorded as a
 * closed ledger row (history + the once-per-24h dedupe).
 *
 * Fail-open by design: an API error reads as "unknown", never as "dead" —
 * an AeroAPI outage must not pause the fleet.
 */

export interface GuardRoute {
  flight_id: string;
  origin: string;
  destination: string;
}

export type DayState = "alive" | "dead" | "unknown";

export interface SweepDay {
  date: string; // YYYY-MM-DD
  state: DayState;
  detail: string;
}

export interface SweepVerdict {
  days: SweepDay[];
  /** Every swept day dead (cancelled/absent) — nothing unknown, nothing alive. */
  allDead: boolean;
}

/** Days ahead the sweep inspects (+1..+N). */
export const SWEEP_HORIZON_DAYS = 5;
/** Days covered by live tracking (/flights); the rest use /schedules. */
const NEAR_DAYS = 2;
const SWEEP_DEDUPE_HOURS = 24;
const DAY_SECS = 86_400;

const dayStr = (dayIndex: number) =>
  new Date(dayIndex * DAY_SECS * 1000).toISOString().slice(0, 10);

/**
 * The 5-day verdict: 2 AeroAPI calls, no writes anywhere.
 * Exported separately so the revive cron and tests reuse the exact logic.
 */
export async function sweepVerdict(
  aero: AeroApiClient,
  route: GuardRoute,
  todayIdx = Math.floor(Date.now() / 1000 / DAY_SECS)
): Promise<SweepVerdict> {
  const days: SweepDay[] = [];

  // ── Days +1..+2 — live tracking, one range call ────────────────────
  const nearStart = `${dayStr(todayIdx + 1)}T00:00:00Z`;
  const nearEnd = `${dayStr(todayIdx + NEAR_DAYS)}T23:59:59Z`;
  const instances = await aero.getFlightInstances(route.flight_id, nearStart, nearEnd);
  for (let offset = 1; offset <= NEAR_DAYS; offset++) {
    const date = dayStr(todayIdx + offset);
    if (instances === null) {
      days.push({ date, state: "unknown", detail: "live-data call failed" });
      continue;
    }
    const dayInsts = instances.filter(
      (f) => (f.scheduled_out ?? f.scheduled_in ?? "").slice(0, 10) === date
    );
    if (dayInsts.length === 0) {
      days.push({ date, state: "dead", detail: "absent from live tracking" });
    } else if (dayInsts.some((f) => !f.cancelled)) {
      days.push({ date, state: "alive", detail: "tracked as operating" });
    } else if (dayInsts.some((f) => isConfirmedCancellation(f))) {
      days.push({ date, state: "dead", detail: "cancelled (corroborated)" });
    } else {
      // Bare cancelled flag = "no longer tracked" — not proof of anything.
      days.push({ date, state: "unknown", detail: "uncorroborated cancel flag" });
    }
  }

  // ── Days +3..+5 — published schedule, one pair call ────────────────
  const farStart = dayStr(todayIdx + NEAR_DAYS + 1);
  const farEndExclusive = dayStr(todayIdx + SWEEP_HORIZON_DAYS + 1);
  const schedules = await aero.getSchedules(farStart, farEndExclusive, {
    origin: route.origin,
    destination: route.destination,
  });
  const complete = schedules !== null && !schedules.links?.next;
  for (let offset = NEAR_DAYS + 1; offset <= SWEEP_HORIZON_DAYS; offset++) {
    const date = dayStr(todayIdx + offset);
    if (!complete) {
      days.push({ date, state: "unknown", detail: "schedules call failed/partial" });
      continue;
    }
    const published = (schedules?.scheduled ?? []).some(
      (s) =>
        (s.actual_ident ?? s.ident) === route.flight_id &&
        (s.scheduled_out ?? "").slice(0, 10) === date
    );
    days.push(
      published
        ? { date, state: "alive", detail: "in published schedule" }
        : { date, state: "dead", detail: "not in published schedule" }
    );
  }

  return { days, allDead: days.every((d) => d.state === "dead") };
}

export interface GuardResult {
  swept: boolean;
  verdict?: SweepVerdict;
  outcome: string;
}

/**
 * The JIT endpoint's fire-on-anomaly entry point. Never throws — a guard
 * failure must not turn a clean buy refusal into a 500.
 */
export async function guardRoute(
  config: GovChainConfig,
  route: GuardRoute,
  aero: AeroApiClient,
  actor = "guard:sale-auth"
): Promise<GuardResult> {
  const label = `${route.flight_id} ${route.origin}→${route.destination}`;
  try {
    if (await checkedRecently(route, "cancellation", SWEEP_DEDUPE_HOURS)) {
      return { swept: false, outcome: "already swept in the last 24h" };
    }
    const verdict = await sweepVerdict(aero, route);
    console.log(
      `[route-guard] ${label}: ${verdict.days.map((d) => `${d.date}=${d.state}`).join(" ")}`
    );
    if (!verdict.allDead) {
      await recordCheck(route, "cancellation", verdict.days, actor);
      return { swept: true, verdict, outcome: "route alive — no pause" };
    }
    const paused = await pauseRoute(config, route, "cancellation", verdict.days, actor);
    return { swept: true, verdict, outcome: paused.outcome };
  } catch (err) {
    console.error(`[route-guard] ${label}: sweep failed (ignored): ${err}`);
    return { swept: false, outcome: `sweep error: ${err}` };
  }
}
