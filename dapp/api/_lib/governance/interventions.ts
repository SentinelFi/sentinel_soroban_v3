import { getDb } from "./db";
import { GovSubmitter } from "./submitter";

/**
 * interventions — THE unified pause ledger + executor (2026-08-01 rework).
 *
 * One question, one table: "which routes are turned OFF right now, who
 * turned them off, on what evidence, and what has to become true to turn
 * them back on?" Every automated or admin pause in the system is one OPEN
 * row here (revived_at null); turning a route back on closes the row. The
 * old three-way split (signals + reconciler's pause_events + the guard's
 * route_health) collapses into this.
 *
 * CAUSES — each owned end-to-end by one detector and one revive predicate:
 *   cancellation  route guard's 5-day sweep says the flight is dead
 *                 → revived when the sweep finds a live day (daily-ish)
 *   exposure      one route/airport holds too much of the vault
 *                 → revived when concentration stays eased 2 checks (hourly)
 *   weather       EXTREME forecast (hurricane-force) at either airport
 *                 → revived the hour the forecast clears
 *   pricing       honest ML price above the base cap on a LIVE route
 *                 → revived by the next pricing run that prices it under
 *   admin         a human said stop
 *                 → NEVER auto-revived; admin closes it
 *
 * EXECUTOR RULES (enforced here, once, for every caller):
 *   - ops_flags.gov_frozen → no automated pause/revive actions at all;
 *   - routes.pinned        → automated causes never touch a pinned route;
 *   - the chain write goes through GovSubmitter (audit: actions_log);
 *   - DB `routes.status` mirrors the decision so gov_onboard and the JIT
 *     endpoint agree with the chain;
 *   - a route re-ENABLES only when its LAST open intervention closes —
 *     overlapping causes each heal independently.
 *
 * Premium changes deliberately do NOT live here: prices are stateless
 * declarations (base + surcharge recomputed every pass, audited in
 * actions_log) — a price needs no "turning back on", so a revert-from-log
 * would only reintroduce the drift bugs the 07-30 redesign removed.
 *
 * DB-optional posture: this is governance-tier machinery. Without a DB
 * there is no ledger, so pause requests degrade to log-only (the caller's
 * fail-closed refusals still protect the vault); with a DB but no
 * gov-admin key, rows are recorded and flagged but the chain is untouched.
 */

export type InterventionCause = "cancellation" | "exposure" | "weather" | "pricing" | "admin";

export interface InterventionRoute {
  flight_id: string;
  origin: string;
  destination: string;
}

export interface InterventionRow {
  id: string;
  flight_id: string;
  origin: string;
  dest: string;
  cause: InterventionCause;
  evidence: unknown;
  opened_by: string;
  opened_at: string;
  last_checked_at: string;
  clear_streak: number;
  revived_at: string | null;
  revived_by: string | null;
}

/** The slice of chain config the executor needs (structural — Config fits). */
export interface GovChainConfig {
  stellarRpcUrl: string;
  networkPassphrase: string;
  governanceId: string;
  governanceAdminSecretKey?: string;
}

/**
 * Per-run cap on NEW automated pauses — the mass-disable circuit breaker
 * (2026-07-27 audit): one broad condition (a hub-wide storm, a fat-finger
 * threshold) must never shut the whole fleet in a single tick. A run may
 * disable at most max(3, 20% of the fleet); the rest is flagged for the
 * admin. A storm can slow the fleet; only a human can stop it.
 */
export function computeDisableCap(routeCount: number): number {
  return Math.max(3, Math.ceil(routeCount * 0.2));
}

async function ensureTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    create table if not exists interventions (
      id bigint generated always as identity primary key,
      flight_id text not null,
      origin text not null,
      dest text not null,
      cause text not null,
      evidence jsonb,
      opened_by text not null,
      opened_at timestamptz not null default now(),
      last_checked_at timestamptz not null default now(),
      clear_streak int not null default 0,
      revived_at timestamptz,
      revived_by text
    )
  `;
  await sql`
    create unique index if not exists interventions_open_key
    on interventions (flight_id, origin, dest, cause)
    where revived_at is null
  `;
}

async function govFrozen(sql: ReturnType<typeof getDb>): Promise<boolean> {
  try {
    const rows = (await sql`
      select value from ops_flags where key = 'gov_frozen'
    `) as unknown as Array<{ value: boolean }>;
    return Boolean(rows[0]?.value);
  } catch {
    return false; // flag table unreadable → don't block a legitimate action
  }
}

async function isPinned(sql: ReturnType<typeof getDb>, route: InterventionRoute): Promise<boolean> {
  try {
    const rows = (await sql`
      select pinned, pin_until from routes
      where flight_id = ${route.flight_id} and origin = ${route.origin}
        and dest = ${route.destination}
    `) as unknown as Array<{ pinned: boolean; pin_until: string | null }>;
    const r = rows[0];
    return Boolean(r?.pinned && (!r.pin_until || new Date(r.pin_until) > new Date()));
  } catch {
    return false;
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

const routeKey = (r: InterventionRoute) => ({
  flightId: r.flight_id,
  origin: r.origin,
  dest: r.destination,
});

export interface PauseResult {
  /** What actually happened, for run logs. */
  outcome: string;
  /** True when this call disabled the route on-chain (counts against caps). */
  disabledOnChain: boolean;
}

/**
 * Pause a route: guardrails → disable on-chain → open ledger row → mirror
 * DB status. Idempotent: an existing open row for (route, cause) is
 * refreshed, not duplicated. `actor` is the detector ('guard:sale-auth',
 * 'cron:gov_exposure', 'cron:weather', 'cron:reprice', 'admin:<email>').
 */
export async function pauseRoute(
  config: GovChainConfig,
  route: InterventionRoute,
  cause: InterventionCause,
  evidence: unknown,
  actor: string
): Promise<PauseResult> {
  const label = `${route.flight_id} ${route.origin}→${route.destination}`;
  if (!process.env.GOVERNANCE_DB_URL) {
    console.warn(`[interventions] ${label}: ${cause} pause requested but no DB — log-only.`);
    return { outcome: "no DB — pause skipped (log-only)", disabledOnChain: false };
  }
  const sql = getDb();
  await ensureTable(sql);

  if (cause !== "admin") {
    if (await govFrozen(sql)) {
      console.warn(`[interventions] ${label}: governance FROZEN — ${cause} pause skipped.`);
      return { outcome: "gov_frozen — pause skipped", disabledOnChain: false };
    }
    if (await isPinned(sql, route)) {
      console.warn(`[interventions] ${label}: route PINNED — ${cause} pause skipped.`);
      return { outcome: "pinned — pause skipped", disabledOnChain: false };
    }
  }

  // Ledger first — the record must exist even if the chain write fails
  // (the next detector pass retries the disable off the same open row).
  await sql`
    insert into interventions (flight_id, origin, dest, cause, evidence, opened_by)
    values (${route.flight_id}, ${route.origin}, ${route.destination},
            ${cause}, ${sql.json(evidence as never)}, ${actor})
    on conflict (flight_id, origin, dest, cause) where revived_at is null
    do update set evidence = ${sql.json(evidence as never)}, last_checked_at = now(), clear_streak = 0
  `;

  const submitter = makeSubmitter(config, actor);
  if (!submitter) {
    console.warn(`[interventions] ${label}: ${cause} recorded but no gov-admin key — chain untouched.`);
    return { outcome: "recorded; no gov key — chain untouched", disabledOnChain: false };
  }

  const key = routeKey(route);
  const onChain = await submitter.readStatus(key);
  let disabledOnChain = false;
  if (onChain.status === "Active") {
    await submitter.disable(key);
    disabledOnChain = true;
  }
  await sql`
    update routes set status = 'disabled', updated_at = now()
    where flight_id = ${route.flight_id} and origin = ${route.origin}
      and dest = ${route.destination}
  `;
  console.warn(`[interventions] ${label}: PAUSED (${cause}).`);
  return {
    outcome: disabledOnChain ? `paused (${cause})` : `${cause} recorded; already off on-chain`,
    disabledOnChain,
  };
}

/**
 * Close an open intervention. The route re-enables on-chain only when NO
 * other open intervention remains for it — each cause heals independently,
 * and an admin row keeps the route off no matter what the detectors say.
 */
export async function reviveRoute(
  config: GovChainConfig,
  route: InterventionRoute,
  cause: InterventionCause,
  actor: string
): Promise<string> {
  const label = `${route.flight_id} ${route.origin}→${route.destination}`;
  const sql = getDb();
  await ensureTable(sql);

  if (cause !== "admin" && (await govFrozen(sql))) {
    return "gov_frozen — revive skipped";
  }

  await sql`
    update interventions set revived_at = now(), revived_by = ${actor}, last_checked_at = now()
    where flight_id = ${route.flight_id} and origin = ${route.origin}
      and dest = ${route.destination} and cause = ${cause} and revived_at is null
  `;

  const remaining = (await sql`
    select cause from interventions
    where flight_id = ${route.flight_id} and origin = ${route.origin}
      and dest = ${route.destination} and revived_at is null
  `) as unknown as Array<{ cause: string }>;
  if (remaining.length > 0) {
    console.log(`[interventions] ${label}: ${cause} cleared, still held by ${remaining.map((r) => r.cause).join("+")}.`);
    return `${cause} cleared; still paused (${remaining.map((r) => r.cause).join("+")})`;
  }

  const submitter = makeSubmitter(config, actor);
  if (!submitter) return `${cause} cleared; no gov key — chain untouched`;
  const key = routeKey(route);
  const onChain = await submitter.readStatus(key);
  if (onChain.status === "Disabled") {
    await submitter.enable(key);
  }
  await sql`
    update routes set status = 'active', updated_at = now()
    where flight_id = ${route.flight_id} and origin = ${route.origin}
      and dest = ${route.destination}
  `;
  console.log(`[interventions] ${label}: REVIVED (${cause} cleared, no other holds).`);
  return `revived (${cause} cleared)`;
}

/** All open interventions, optionally by cause, most recent first. */
export async function openInterventions(cause?: InterventionCause): Promise<InterventionRow[]> {
  const sql = getDb();
  await ensureTable(sql);
  return (cause
    ? await sql`
        select * from interventions where revived_at is null and cause = ${cause}
        order by opened_at desc
      `
    : await sql`
        select * from interventions where revived_at is null
        order by opened_at desc
      `) as unknown as InterventionRow[];
}

/** Refresh an open row after a still-holding check (streak reset). */
export async function touchIntervention(id: string, evidence?: unknown): Promise<void> {
  const sql = getDb();
  if (evidence !== undefined) {
    await sql`
      update interventions
      set last_checked_at = now(), clear_streak = 0, evidence = ${sql.json(evidence as never)}
      where id = ${id}
    `;
  } else {
    await sql`
      update interventions set last_checked_at = now(), clear_streak = 0 where id = ${id}
    `;
  }
}

/** Count a clear check toward hysteresis; returns the new streak. */
export async function recordClearCheck(id: string): Promise<number> {
  const sql = getDb();
  const rows = (await sql`
    update interventions set last_checked_at = now(), clear_streak = clear_streak + 1
    where id = ${id}
    returning clear_streak
  `) as unknown as Array<{ clear_streak: number }>;
  return rows[0]?.clear_streak ?? 0;
}

/**
 * Record a check that did NOT pause (history + call-economy dedupe for the
 * guard: a CLOSED row whose last_checked_at answers "did we already sweep
 * this route recently?"). No-ops onto the open row if one exists.
 */
export async function recordCheck(
  route: InterventionRoute,
  cause: InterventionCause,
  evidence: unknown,
  actor: string
): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const sql = getDb();
    await ensureTable(sql);
    const open = (await sql`
      select id from interventions
      where flight_id = ${route.flight_id} and origin = ${route.origin}
        and dest = ${route.destination} and cause = ${cause} and revived_at is null
    `) as unknown as Array<{ id: string }>;
    if (open.length > 0) {
      await sql`update interventions set last_checked_at = now(), evidence = ${sql.json(evidence as never)} where id = ${open[0].id}`;
      return;
    }
    await sql`
      insert into interventions (flight_id, origin, dest, cause, evidence, opened_by, revived_at, revived_by)
      values (${route.flight_id}, ${route.origin}, ${route.destination}, ${cause},
              ${sql.json(evidence as never)}, ${actor}, now(), ${actor})
    `;
  } catch (err) {
    console.warn(`[interventions] recordCheck failed (ignored): ${err}`);
  }
}

/** Any check (open or closed) for (route, cause) within the last N hours? */
export async function checkedRecently(
  route: InterventionRoute,
  cause: InterventionCause,
  hours: number
): Promise<boolean> {
  if (!process.env.GOVERNANCE_DB_URL) return false;
  try {
    const sql = getDb();
    await ensureTable(sql);
    const rows = (await sql`
      select 1 from interventions
      where flight_id = ${route.flight_id} and origin = ${route.origin}
        and dest = ${route.destination} and cause = ${cause}
        and last_checked_at > now() - make_interval(hours => ${hours})
      limit 1
    `) as unknown as unknown[];
    return rows.length > 0;
  } catch (err) {
    console.warn(`[interventions] checkedRecently failed (${err}) — treating as not recent.`);
    return false;
  }
}
