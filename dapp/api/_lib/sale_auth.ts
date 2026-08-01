import { SorobanClient } from "./soroban_client";
import { AeroApiClient, isConfirmedCancellation } from "./aeroapi_client";
import { classifyAndSettleFlight } from "./targeted_settlement";
import { parseFlightStatus } from "./status";
import { loadRoutesConfig } from "./routes_config";
import { saveFlightSchedule } from "./flight_schedules";
import { guardRoute, type GuardRoute } from "./route_guard";
import { getDb } from "./governance/db";
import { FlightStatus, type Config, type FetcherAction } from "./types";

/**
 * JIT sale authorization — the demand-driven replacement for the polled
 * sale-authorizer cron (2026-07-31 rework). AeroAPI is consulted the
 * moment a buyer acts, never on a schedule:
 *
 *   buy click → POST /api/sale-auth/request → authorizeSale()
 *
 * The on-chain purchase gate is unchanged: buying requires a live,
 * unexpired sale window written by the oracle. This module is now the
 * ONLY writer of those windows, split by AeroAPI visibility:
 *
 *   - departure < MIN LEAD (24h)      → refuse, zero API calls;
 *   - days +1..+2 (live tracking)     → one /flights call. A corroborated
 *     cancellation refuses the buy, writes the purchase-blocking
 *     set_cancelled tombstone, and fires the route guard's 5-day sweep;
 *   - days +3..horizon (published)    → one /schedules presence check for
 *     the pair+date. Vanished from the schedule → refuse + fire the sweep.
 *     Presence attests "published as scheduled", deliberately NOT "not
 *     cancelled" — beyond live-tracking visibility that fact does not
 *     exist yet, which is precisely the uncertainty the product insures.
 *
 * A clean check opens the window with expiry
 *   min(now + validity, scheduled departure − MIN LEAD)
 * so no window ever authorizes a purchase inside the 24h cutoff, and
 * stores the scheduled dep/arr in flight_schedules (the settle cron's
 * timing hint). While a window is live, later buyers of the same
 * (flight, day) ride it for free — zero API calls, zero writes.
 *
 * Call economy: an idle whitelisted route costs NOTHING. Every refusal
 * path fails closed (no window = the contract rejects the buy), and an
 * abusive caller can at worst re-run the checks the old cron used to run
 * unconditionally — bounded by fleet × horizon per validity period, with
 * repeat probes of the same (flight, day) absorbed by the live window or
 * the tombstone before any API call is made.
 */

const DAY_SECS = 86_400;

/** Optional dependency injection seam — tests pass fakes, production omits. */
export interface SaleAuthDeps {
  soroban?: SorobanClient;
  aero?: AeroApiClient;
  /** Replace the route-guard sweep (tests); default fires guardRoute. */
  guard?: (route: GuardRoute) => Promise<unknown>;
}

export interface SaleAuthResult {
  authorized: boolean;
  reason: string;
  /** Unix seconds — present when authorized. */
  expiresAt?: number;
  scheduledOut?: string | null;
  scheduledIn?: string | null;
  /** On-chain writes performed (window/tombstone), for run logs. */
  actions: FetcherAction[];
}

interface SellableRoute {
  flight_id: string;
  origin: string;
  destination: string;
}

/**
 * Same source-of-truth rule as the old authorizer: the DB `routes` table
 * is canonical once populated (a guard/reconciler/admin disable also stops
 * authorization), the fleet file is the bootstrap seed and the no-DB
 * fallback.
 */
async function findSellableRoute(flightId: string): Promise<SellableRoute | null> {
  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const sql = getDb();
      const all = (await sql`select flight_id, origin, dest, status from routes`) as unknown as Array<{
        flight_id: string;
        origin: string;
        dest: string;
        status: string;
      }>;
      if (all.length > 0) {
        const row = all.find((r) => r.flight_id === flightId && r.status === "active");
        return row ? { flight_id: row.flight_id, origin: row.origin, destination: row.dest } : null;
      }
    } catch (err) {
      console.warn(`[sale-auth] routes DB unreachable (${err}) — falling back to the routes file.`);
    }
  }
  const config = loadRoutesConfig();
  const route = config.routes.find((r) => r.flight_id === flightId && r.enabled);
  return route
    ? { flight_id: route.flight_id, origin: route.origin, destination: route.destination }
    : null;
}

export async function authorizeSale(
  config: Config,
  flightId: string,
  dateSecs: bigint,
  deps: SaleAuthDeps = {}
): Promise<SaleAuthResult> {
  const actions: FetcherAction[] = [];
  const refuse = (reason: string): SaleAuthResult => ({ authorized: false, reason, actions });

  const nowSecs = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor(nowSecs / DAY_SECS);
  const dateIdx = Number(dateSecs / BigInt(DAY_SECS));
  const dateStr = new Date(Number(dateSecs) * 1000).toISOString().slice(0, 10);
  const label = `${flightId}@${dateStr}`;

  // ── Free gates (no API, no chain writes) ───────────────────────────
  const route = await findSellableRoute(flightId);
  if (!route) return refuse("route not whitelisted or disabled");

  const routesConfig = loadRoutesConfig();
  const horizonDays =
    config.saleAuthHorizonDays > 0 ? config.saleAuthHorizonDays : routesConfig.saleHorizonDays;
  const dayOffset = dateIdx - todayIdx;
  if (dayOffset < 1) return refuse("flights inside the minimum lead time are not sellable");
  if (dayOffset > horizonDays) return refuse(`beyond the ${horizonDays}-day sale horizon`);

  const client = deps.soroban ?? new SorobanClient(config);
  const aero = deps.aero ?? new AeroApiClient(config);
  // OCA-M04: the endpoint's maxDuration is 60s but a single 429 cooldown
  // sleeps 65s — cap API time so a rate-limit burst degrades to a clean
  // refusal instead of a platform kill mid-request.
  aero.setDeadline(Date.now() + 45_000);
  const guard = deps.guard ?? ((r: GuardRoute) => guardRoute(config, r, aero));
  const oracleId = config.oracleAggregatorId;
  const oraclePublicKey = client.publicKeyFromSecret(config.oracleSecretKey);

  // A recorded outcome is final — the contract rejects open_sale anyway.
  const onChain = await client.readContract(oracleId, "get_flight_data", [
    client.symbolToScVal(flightId),
    client.u64ToScVal(dateSecs),
  ]);
  const onChainStatus = parseFlightStatus(onChain.status);
  if (onChainStatus !== FlightStatus.NotInitiated && onChainStatus !== FlightStatus.Active) {
    return refuse(`flight already has a recorded outcome (${onChainStatus})`);
  }

  // The live window IS the cached attestation — every buyer inside its
  // validity rides the first buyer's API call.
  const rawExpiry = await client.readContract(oracleId, "get_sale_auth", [
    client.symbolToScVal(flightId),
    client.u64ToScVal(dateSecs),
  ]);
  const liveExpiry = rawExpiry === null || rawExpiry === undefined ? null : BigInt(rawExpiry);
  if (liveExpiry !== null && liveExpiry > BigInt(nowSecs + 60)) {
    return {
      authorized: true,
      reason: "existing sale window",
      expiresAt: Number(liveExpiry),
      actions,
    };
  }

  // ── One API call, split by visibility ──────────────────────────────
  const minLead = config.saleMinLeadSecs;
  let scheduledOut: string | null;
  let scheduledIn: string | null;

  if (dayOffset <= 2) {
    // Live tracking.
    const apiData = await aero.getFlightData(flightId, dateStr);
    if (!apiData) {
      return refuse("flight not verifiable for that date");
    }
    if (apiData.cancelled) {
      if (isConfirmedCancellation(apiData)) {
        // Purchase-blocking tombstone (the contract accepts it before any
        // registration), then targeted settle for any existing buyers,
        // then the 5-day route sweep.
        console.log(`[sale-auth] ${label}: cancelled — writing tombstone`);
        await client.invokeContract(
          oracleId,
          "set_cancelled",
          [
            client.addressToScVal(oraclePublicKey),
            client.symbolToScVal(flightId),
            client.u64ToScVal(dateSecs),
          ],
          config.oracleSecretKey
        );
        actions.push({ flight: label, transition: "→ Cancelled (tombstone)" });
        await classifyAndSettleFlight(client, config, flightId, dateSecs, label, actions);
        await guard(route);
        return refuse("flight is cancelled");
      }
      // Bare flag = "no longer tracked" — not proof, never tombstone,
      // and not a sweep trigger. Fail closed on the sale only.
      return refuse(`cancellation signal unconfirmed (status "${apiData.status}")`);
    }
    scheduledOut = apiData.scheduled_out ?? null;
    scheduledIn = apiData.scheduled_in;
  } else {
    // Published schedule: presence check for the exact pair + date.
    const nextDayStr = new Date((dateIdx + 1) * DAY_SECS * 1000).toISOString().slice(0, 10);
    const schedules = await aero.getSchedules(dateStr, nextDayStr, {
      origin: route.origin,
      destination: route.destination,
    });
    if (!schedules || schedules.links?.next) {
      return refuse("published schedule not verifiable right now");
    }
    const rows = (schedules.scheduled ?? []).filter(
      (s) =>
        (s.actual_ident ?? s.ident) === flightId &&
        (s.scheduled_out ?? "").slice(0, 10) === dateStr
    );
    const match = rows[0];
    if (!match) {
      await guard(route);
      return refuse("flight is not in the published schedule for that date");
    }
    if (rows.length > 1) {
      return refuse("ambiguous published schedule (multiple instances)");
    }
    scheduledOut = match.scheduled_out;
    scheduledIn = match.scheduled_in;
  }

  // ── The 24h cutoff, against the real departure time ────────────────
  const departure = parseIsoSecs(scheduledOut) ?? parseIsoSecs(scheduledIn);
  if (departure === null) {
    return refuse("no scheduled departure time available");
  }
  if (departure - nowSecs < minLead) {
    return refuse(`departs in less than ${Math.round(minLead / 3600)}h`);
  }

  // ── Open the window ────────────────────────────────────────────────
  const expiresAt = Math.min(nowSecs + config.saleAuthValiditySecs, departure - minLead);
  await client.invokeContract(
    oracleId,
    "open_sale",
    [
      client.addressToScVal(oraclePublicKey),
      client.symbolToScVal(flightId),
      client.u64ToScVal(dateSecs),
      client.u64ToScVal(BigInt(expiresAt)),
    ],
    config.oracleSecretKey
  );
  actions.push({ flight: label, transition: `sale open until ${expiresAt}` });

  // Timing hint for the settle cron (fail-open, DB-optional).
  await saveFlightSchedule(
    flightId,
    dateSecs,
    departure ? BigInt(departure) : null,
    parseIsoSecs(scheduledIn) !== null ? BigInt(parseIsoSecs(scheduledIn)!) : null
  );

  return {
    authorized: true,
    reason: "verified and authorized",
    expiresAt,
    scheduledOut,
    scheduledIn,
    actions,
  };
}

function parseIsoSecs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
