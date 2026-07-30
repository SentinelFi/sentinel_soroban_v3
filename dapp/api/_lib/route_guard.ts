import { AeroApiClient, isConfirmedCancellation } from "./aeroapi_client";
import { getDb } from "./governance/db";
import { GovSubmitter } from "./governance/submitter";

/**
 * The slice of chain config pause/revive execution needs — both the full
 * cron Config (JIT endpoint) and a GovConfig adaptation (revive cron)
 * satisfy it structurally.
 */
export interface GovChainConfig {
  stellarRpcUrl: string;
  networkPassphrase: string;
  governanceId: string;
  governanceAdminSecretKey?: string;
}

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
 * ALL five days dead → the route is disabled on-chain (the exploit being
 * closed: buying future days of a flight that is publicly not operating)
 * and recorded in `route_health`, the single DB table the daily revive
 * cron and the admin work from. Any day alive or unverifiable → no pause;
 * the buy refusal (and per-day tombstones) already protect the vault.
 *
 * Fail-open by design: an API error reads as "unknown", never as "dead" —
 * an AeroAPI outage must not pause the fleet. Sweeps are deduped to one
 * per route per 24h via route_health.last_swept_at (no DB → no dedupe,
 * which only costs the two calls). Pausing requires the gov-admin key and
 * respects the ops_flags.gov_frozen kill switch; with no key or no DB the
 * verdict is logged for ops and nothing is written.
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

// ── route_health — the one guard/revive table ─────────────────────────
// One row per route, current state only: when it was paused and why, when
// it was revived, when it was last swept. Self-creating, DB-optional.

async function ensureHealthTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    create table if not exists route_health (
      flight_id text not null,
      origin text not null,
      dest text not null,
      paused_at timestamptz,
      pause_reason text,
      evidence jsonb,
      revived_at timestamptz,
      last_swept_at timestamptz,
      primary key (flight_id, origin, dest)
    )
  `;
}

async function sweptRecently(route: GuardRoute): Promise<boolean> {
  if (!process.env.GOVERNANCE_DB_URL) return false;
  try {
    const sql = getDb();
    await ensureHealthTable(sql);
    const rows = (await sql`
      select 1 from route_health
      where flight_id = ${route.flight_id} and origin = ${route.origin}
        and dest = ${route.destination}
        and last_swept_at > now() - make_interval(hours => ${SWEEP_DEDUPE_HOURS})
    `) as unknown as unknown[];
    return rows.length > 0;
  } catch (err) {
    console.warn(`[route-guard] dedupe check failed (${err}) — sweeping anyway.`);
    return false;
  }
}

async function markSwept(route: GuardRoute): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const sql = getDb();
    await ensureHealthTable(sql);
    await sql`
      insert into route_health (flight_id, origin, dest, last_swept_at)
      values (${route.flight_id}, ${route.origin}, ${route.destination}, now())
      on conflict (flight_id, origin, dest) do update set last_swept_at = now()
    `;
  } catch (err) {
    console.warn(`[route-guard] markSwept failed (ignored): ${err}`);
  }
}

/** Currently-paused routes, most recently paused first. */
export async function pausedRoutes(limit: number | null): Promise<GuardRoute[]> {
  const sql = getDb();
  await ensureHealthTable(sql);
  const rows = (limit === null
    ? await sql`
        select flight_id, origin, dest from route_health
        where paused_at is not null and revived_at is null
        order by paused_at desc
      `
    : await sql`
        select flight_id, origin, dest from route_health
        where paused_at is not null and revived_at is null
        order by paused_at desc
        limit ${limit}
      `) as unknown as Array<{ flight_id: string; origin: string; dest: string }>;
  return rows.map((r) => ({ flight_id: r.flight_id, origin: r.origin, destination: r.dest }));
}

async function govFrozen(): Promise<boolean> {
  if (!process.env.GOVERNANCE_DB_URL) return false;
  try {
    const sql = getDb();
    const rows = (await sql`
      select value from ops_flags where key = 'gov_frozen'
    `) as unknown as Array<{ value: boolean }>;
    return Boolean(rows[0]?.value);
  } catch {
    return false; // flag table unreadable → don't block a legitimate pause
  }
}

function makeSubmitter(config: GovChainConfig, actor: string): GovSubmitter | null {
  if (!config.governanceAdminSecretKey) return null;
  return new GovSubmitter({
    rpcUrl: config.stellarRpcUrl,
    networkPassphrase: config.networkPassphrase,
    governanceId: config.governanceId,
    adminSecretKey: config.governanceAdminSecretKey,
    actor,
  });
}

/** Disable the route on-chain + mirror to the DB. Returns what happened. */
export async function executePause(
  config: GovChainConfig,
  route: GuardRoute,
  verdict: SweepVerdict,
  actor: string
): Promise<string> {
  const label = `${route.flight_id} ${route.origin}→${route.destination}`;
  if (await govFrozen()) {
    console.warn(`[route-guard] ${label}: all 5 days dead but governance is FROZEN — not pausing.`);
    return "frozen — pause skipped";
  }
  const submitter = makeSubmitter(config, actor);
  if (!submitter) {
    console.warn(`[route-guard] ${label}: all 5 days dead but no GOVERNANCE_ADMIN_SECRET_KEY — verdict logged only.`);
    return "no gov key — pause skipped";
  }

  const key = { flightId: route.flight_id, origin: route.origin, dest: route.destination };
  const onChain = await submitter.readStatus(key);
  if (onChain.status === "Active") {
    await submitter.disable(key);
  }

  const reason = "cancellation sweep: all 5 days dead";
  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const sql = getDb();
      await ensureHealthTable(sql);
      await sql`
        insert into route_health (flight_id, origin, dest, paused_at, pause_reason, evidence, revived_at, last_swept_at)
        values (${route.flight_id}, ${route.origin}, ${route.destination},
                now(), ${reason}, ${sql.json(verdict.days as never)}, null, now())
        on conflict (flight_id, origin, dest) do update
          set paused_at = now(), pause_reason = ${reason},
              evidence = ${sql.json(verdict.days as never)},
              revived_at = null, last_swept_at = now()
      `;
      // Keep the reconciler's world honest: 'disabled' is the admin-
      // lifecycle status it enforces and never auto-re-enables.
      await sql`
        update routes set status = 'disabled', updated_at = now()
        where flight_id = ${route.flight_id} and origin = ${route.origin}
          and dest = ${route.destination}
      `;
    } catch (err) {
      console.warn(`[route-guard] ${label}: DB mirror failed after on-chain pause: ${err}`);
    }
  }
  console.warn(`[route-guard] ${label}: PAUSED (${reason}).`);
  return onChain.status === "Active" ? "paused" : "already disabled on-chain; DB updated";
}

/** Re-enable a paused route on-chain + mirror to the DB. */
export async function executeRevive(
  config: GovChainConfig,
  route: GuardRoute,
  verdict: SweepVerdict,
  actor: string
): Promise<void> {
  const submitter = makeSubmitter(config, actor);
  if (!submitter) throw new Error("GOVERNANCE_ADMIN_SECRET_KEY required to revive routes");
  const key = { flightId: route.flight_id, origin: route.origin, dest: route.destination };
  const onChain = await submitter.readStatus(key);
  if (onChain.status === "Disabled") {
    await submitter.enable(key);
  }
  const sql = getDb();
  await ensureHealthTable(sql);
  await sql`
    update route_health
    set revived_at = now(), last_swept_at = now(), evidence = ${sql.json(verdict.days as never)}
    where flight_id = ${route.flight_id} and origin = ${route.origin}
      and dest = ${route.destination}
  `;
  await sql`
    update routes set status = 'active', updated_at = now()
    where flight_id = ${route.flight_id} and origin = ${route.origin}
      and dest = ${route.destination}
  `;
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
    if (await sweptRecently(route)) {
      return { swept: false, outcome: "already swept in the last 24h" };
    }
    const verdict = await sweepVerdict(aero, route);
    await markSwept(route);
    console.log(
      `[route-guard] ${label}: ${verdict.days.map((d) => `${d.date}=${d.state}`).join(" ")}`
    );
    if (!verdict.allDead) {
      return { swept: true, verdict, outcome: "route alive — no pause" };
    }
    const outcome = await executePause(config, route, verdict, actor);
    return { swept: true, verdict, outcome };
  } catch (err) {
    console.error(`[route-guard] ${label}: sweep failed (ignored): ${err}`);
    return { swept: false, outcome: `sweep error: ${err}` };
  }
}
