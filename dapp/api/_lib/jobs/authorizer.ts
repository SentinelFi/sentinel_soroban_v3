import { SorobanClient } from "../soroban_client";
import { AeroApiClient, isConfirmedCancellation } from "../aeroapi_client";
import { classifyAndSettleFlight } from "../targeted_settlement";
import { parseFlightStatus } from "../status";
import { loadRoutesConfig, type RoutesConfig } from "../routes_config";
import { getDb } from "../governance/db";
import { cachedFetch } from "../aeroapi_cache";
import {
  FlightStatus,
  type Config,
  type RunLogEntry,
  type FetcherAction,
} from "../types";

const SECONDS_PER_DAY = 86_400;
// /flights/{ident} visibility: start/end within 2 days of future. Days 1..2
// are attested from live tracking data; further days from published
// schedules (/schedules, visible up to 1 year out, ≤3-week windows).
const NEAR_WINDOW_DAYS = 2;
const SCHEDULE_CHUNK_DAYS = 20; // stay under the API's 3-week span limit
// Published schedules barely change — cache pair-chunks ~24h (DB-optional).
const SCHEDULE_CACHE_TTL_SECS = 24 * 3600;

/** Optional dependency injection seam — tests pass fakes, production omits. */
export interface AuthorizerDeps {
  soroban?: SorobanClient;
  aero?: AeroApiClient;
}

interface AttestRoute {
  flight_id: string;
  origin: string;
  destination: string;
}

/**
 * Route source: the DB `routes` table is canonical once gov_onboard has
 * populated it — an admin/reconciler disable then also stops ATTESTATION,
 * not just purchases. The routes file remains the bootstrap seed and the
 * fallback, honoring the DB-optional invariant (this is an oracle-tier
 * job and must run with no database):
 *   - no GOVERNANCE_DB_URL          → file
 *   - DB unreachable / query fails  → file (warn)
 *   - DB reachable but ZERO rows    → file (unseeded bootstrap)
 *   - DB has rows                   → DB is law ('active' rows only —
 *     an all-disabled table attests NOTHING, it does not fall back)
 */
async function loadAttestRoutes(
  routesConfig: RoutesConfig
): Promise<{ routes: AttestRoute[]; source: "db" | "file" }> {
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
        return {
          routes: all
            .filter((r) => r.status === "active")
            .map((r) => ({ flight_id: r.flight_id, origin: r.origin, destination: r.dest })),
          source: "db",
        };
      }
    } catch (err) {
      console.warn(`[authorizer] routes DB unreachable (${err}) — falling back to the routes file.`);
    }
  }
  return {
    routes: routesConfig.routes
      .filter((r) => r.enabled)
      .map((r) => ({ flight_id: r.flight_id, origin: r.origin, destination: r.destination })),
    source: "file",
  };
}

/**
 * Cron #0 — SaleAuthorizer (every 2 hours, offset from the fetcher)
 *
 * The on-chain purchase gate requires a live, unexpired sale authorization
 * from the oracle: absence of an on-chain outcome proves nothing about the
 * real flight (a publicly cancelled flight looks identical to a valid
 * unreported one until the cancellation write lands), so insurability is
 * attested affirmatively instead of inferred. This job is that attestation
 * loop, split by AeroAPI visibility:
 *
 * NEAR WINDOW (days 1..2) — live tracking data via /flights/{ident}:
 * 1. asks AeroAPI whether the (flight, day) instance is scheduled;
 * 2. the moment a cancellation is visible, revokes any live sale window
 *    with the pause-exempt `close_sale` FIRST (fail closed on the bare
 *    `cancelled` flag), then — only when the status text corroborates an
 *    actual cancellation (isConfirmedCancellation) — pushes the
 *    `set_cancelled` tombstone and drives targeted settlement. The bare
 *    flag alone can mean "tracking lost", and the tombstone pays every
 *    buyer, so it is never written uncorroborated;
 * 3. closes the sale window when the instance becomes unverifiable
 *    (no data / ambiguous candidates) — fail closed, never guess;
 * 4. otherwise opens/refreshes the window with a bounded expiry
 *    (`min(flight date, now + validity)`, validity capped on-chain at 24h).
 *
 * FAR WINDOW (days 3..horizon) — published schedules via /schedules:
 * /flights cannot see past 2 days of future schedule (the old per-day sweep
 * burned a guaranteed-failing call per flight per day out there). Batched:
 * ONE /schedules call per DIRECTED PAIR per ≤20-day chunk (200 routes share
 * ~30 pairs; the server-side pair filter also excludes a multi-leg flight
 * number's other legs), each call cached ~24h in the governance DB
 * (best-effort, DB-optional). Rows are matched to flights by ident:
 * - exactly one instance on a day  → open/refresh that day's window;
 * - zero instances (verified absent) → close any live window — the airline
 *   no longer publishes the flight for that day;
 * - more than one instance → ambiguous, fail closed;
 * - the /schedules call itself failed → take NO action for those days;
 *   existing windows simply lapse within their ≤6h validity (fail closed
 *   by expiry, without letting one transient API error revoke 20 days of
 *   honest windows at once).
 * Published-schedule existence deliberately does NOT attest "not
 * cancelled" (the spec says schedule rows may not reflect actual flight
 * information) — cancellation detection lives in the near window and the
 * fetcher's watch window, both on live tracking data.
 *
 * Call economy: a near-window /flights call only fires when the live sale
 * window actually needs a refresh (less than half its validity left) — the
 * window itself is the cached attestation — and never again once a (flight,
 * day) has a recorded outcome. Far window: pairs × ceil((horizon−2)/20)
 * /schedules calls per CACHE MISS (~once/day) — e.g. 200 routes over 30
 * pairs at a 7-day horizon ≈ 30 schedule calls per day total, vs the
 * original design's 200 per run (2,400/day).
 *
 * If this job stops running, every window lapses within its validity and
 * sales halt protocol-wide — that is the intended fail-safe, not a bug.
 *
 * The flight list is DERIVED from config/routes.testnet.json (enabled
 * routes) — one source of truth with the governance whitelist. The horizon
 * likewise defaults to the file's sale_horizon_days (SALE_AUTH_HORIZON_DAYS
 * env still overrides).
 */
export async function run(config: Config, deps: AuthorizerDeps = {}): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];

  try {
    const routesConfig = loadRoutesConfig();
    const { routes: attestRoutes, source } = await loadAttestRoutes(routesConfig);
    const flightIds = [...new Set(attestRoutes.map((r) => r.flight_id))];
    const horizonDays =
      config.saleAuthHorizonDays > 0
        ? config.saleAuthHorizonDays
        : routesConfig.saleHorizonDays;
    console.log(`[authorizer] Route source: ${source} (${flightIds.length} flight number(s)).`);

    if (flightIds.length === 0) {
      console.warn(
        "[authorizer] No enabled routes (source: " + source + ") — no sale windows will be opened and all purchases fail closed."
      );
      return {
        timestamp: new Date().toISOString(),
        job: "sale_authorizer",
        duration_ms: Date.now() - start,
        success: true,
        actions,
      };
    }

    const client = deps.soroban ?? new SorobanClient(config);
    const aeroApi = deps.aero ?? new AeroApiClient(config);
    const oracleId = config.oracleAggregatorId;
    const oraclePublicKey = client.publicKeyFromSecret(config.oracleSecretKey);

    const nowSecs = Math.floor(Date.now() / 1000);
    const todayIndex = Math.floor(nowSecs / SECONDS_PER_DAY);

    console.log(
      `[authorizer] Attesting ${flightIds.length} flight number(s) over ${horizonDays} day(s)...`
    );

    // ── Shared per-day actions ─────────────────────────────────────────

    const dayDate = (dayIndex: number) => ({
      dateSecs: BigInt(dayIndex * SECONDS_PER_DAY),
      dateStr: new Date(dayIndex * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10),
    });

    const closeIfLive = async (flightId: string, dateSecs: bigint, label: string, reason: string) => {
      const currentExpiry = await readSaleExpiry(client, oracleId, flightId, dateSecs);
      if (currentExpiry !== null && currentExpiry > BigInt(nowSecs)) {
        console.log(`[authorizer] ${label}: ${reason} — closing sale window`);
        await client.invokeContract(
          oracleId,
          "close_sale",
          [
            client.addressToScVal(oraclePublicKey),
            client.symbolToScVal(flightId),
            client.u64ToScVal(dateSecs),
          ],
          config.oracleSecretKey
        );
        actions.push({ flight: label, transition: `sale closed (${reason})` });
      }
    };

    const openOrRefresh = async (flightId: string, dateSecs: bigint, label: string) => {
      const currentExpiry = await readSaleExpiry(client, oracleId, flightId, dateSecs);
      const expiresAt = min(dateSecs, BigInt(nowSecs + config.saleAuthValiditySecs));
      // Skip the write while the current window still has most of its life
      // left — keeps refreshes to ~2 per validity period.
      if (
        currentExpiry !== null &&
        currentExpiry - BigInt(nowSecs) >
          BigInt(Math.floor(config.saleAuthValiditySecs / 2)) &&
        currentExpiry >= expiresAt
      ) {
        return; // still fresh
      }
      await client.invokeContract(
        oracleId,
        "open_sale",
        [
          client.addressToScVal(oraclePublicKey),
          client.symbolToScVal(flightId),
          client.u64ToScVal(dateSecs),
          client.u64ToScVal(expiresAt),
        ],
        config.oracleSecretKey
      );
      actions.push({ flight: label, transition: `sale open until ${expiresAt}` });
    };

    // ── Demand mode (opt-in, SALE_AUTH_DEMAND_MODE=true) ───────────────
    // Hot (flight, day) marks written by POST /api/sale-auth/warm on quote
    // views. null = mode off OR hot set unavailable → attest everything
    // (availability fails open; insurability still gates on-chain).
    let demandHot: Set<string> | null = null;
    if (process.env.SALE_AUTH_DEMAND_MODE === "true" && process.env.GOVERNANCE_DB_URL) {
      try {
        const sql = getDb();
        const hot = (await sql`
          select flight_id, date from warm_windows
          where warmed_at > now() - interval '24 hours'
        `) as unknown as Array<{ flight_id: string; date: string | number }>;
        demandHot = new Set(hot.map((h) => `${h.flight_id}|${BigInt(h.date)}`));
        // Housekeeping: drop stale marks (best-effort).
        await sql`delete from warm_windows where warmed_at < now() - interval '48 hours'`;
        console.log(`[authorizer] Demand mode: ${demandHot.size} hot (flight, day) mark(s).`);
      } catch (err) {
        console.warn(`[authorizer] demand-mode hot set unavailable (${err}) — attesting all near-window days.`);
        demandHot = null;
      }
    }

    // ── FAR-WINDOW batch fetch: one /schedules call per DIRECTED PAIR ──
    // per ≤20-day chunk (not per flight — 200 routes share ~30 pairs), and
    // each call is cached ~24h in the governance DB (best-effort,
    // DB-optional: no DB → direct calls, nothing gated). The pair filter
    // also excludes a multi-leg flight number's other legs server-side.
    // counts key: `${flightId}|${dateStr}`.
    const farCounts = new Map<string, number>();
    const farUnknown = new Set<string>(); // `${origin}|${dest}|${dateStr}`
    if (horizonDays > NEAR_WINDOW_DAYS) {
      const pairs = new Map<string, Set<string>>(); // "O|D" -> flightIds
      for (const r of attestRoutes) {
        const key = `${r.origin}|${r.destination}`;
        const set = pairs.get(key) ?? new Set();
        set.add(r.flight_id);
        pairs.set(key, set);
      }
      for (const [pairKey, fids] of pairs) {
        const [origin, destination] = pairKey.split("|");
        let chunkStart = todayIndex + NEAR_WINDOW_DAYS + 1;
        const lastDay = todayIndex + horizonDays;
        while (chunkStart <= lastDay) {
          const chunkEnd = Math.min(chunkStart + SCHEDULE_CHUNK_DAYS - 1, lastDay);
          const startStr = dayDate(chunkStart).dateStr;
          // date_end is exclusive — pass the day AFTER the last wanted day.
          const endStr = dayDate(chunkEnd + 1).dateStr;
          const schedules = await cachedFetch(
            `sched|${origin}|${destination}|${startStr}|${endStr}`,
            SCHEDULE_CACHE_TTL_SECS,
            () => aeroApi.getSchedules(startStr, endStr, { origin, destination })
          );
          if (!schedules || schedules.links?.next) {
            // Failed OR incomplete pagination: an under-counted row set
            // must not close windows as "verified absent" — mark the whole
            // chunk unknown (windows lapse naturally within validity).
            for (let d = chunkStart; d <= chunkEnd; d++) {
              farUnknown.add(`${pairKey}|${dayDate(d).dateStr}`);
            }
          } else {
            for (const entry of schedules.scheduled ?? []) {
              const ident = entry.actual_ident ?? entry.ident;
              if (!fids.has(ident)) continue;
              const day = (entry.scheduled_out ?? "").slice(0, 10);
              if (!day) continue;
              const k = `${ident}|${day}`;
              farCounts.set(k, (farCounts.get(k) ?? 0) + 1);
            }
          }
          chunkStart = chunkEnd + 1;
        }
      }
    }

    // ── Per-flight attestation ─────────────────────────────────────────

    for (const flightId of flightIds) {
      const route = attestRoutes.find((r) => r.flight_id === flightId);

      // NEAR WINDOW — days 1..2, live tracking data.
      // Day 0 is skipped: the controller's min-lead cutoff already blocks
      // same-day purchases, so there is nothing to authorize.
      const nearEnd = Math.min(NEAR_WINDOW_DAYS, horizonDays);
      for (let offset = 1; offset <= nearEnd; offset++) {
        const { dateSecs, dateStr } = dayDate(todayIndex + offset);
        const label = `${flightId}@${dateStr}`;

        // Demand mode (opt-in): only attest near-window days someone has
        // actually looked at. Hot set unavailable (DB off) → attest all
        // (fail open on availability, sales still gate on-chain).
        if (demandHot !== null && !demandHot.has(`${flightId}|${dateSecs}`)) {
          continue;
        }

        try {
          // Call-economy gate 1: the live on-chain window IS a cached
          // attestation — while it still has more than half its validity
          // left (or is clamped at the day boundary, which is maximal for
          // that day), the previous verification stands. Skip the AeroAPI
          // call entirely. Worst-case cancellation-detection lag in the
          // near window becomes ~validity/2 (default 3h), bounded by the
          // window's own expiry — a cancellation is never purchasable
          // longer than the window we already granted.
          const preExpiry = await readSaleExpiry(client, oracleId, flightId, dateSecs);
          if (
            preExpiry !== null &&
            preExpiry > BigInt(nowSecs) &&
            (preExpiry === dateSecs ||
              preExpiry - BigInt(nowSecs) >
                BigInt(Math.floor(config.saleAuthValiditySecs / 2)))
          ) {
            continue; // window fresh — previous attestation stands
          }

          // Call-economy gate 2: a flight with a recorded outcome can never
          // be sold again (open_sale is rejected on-chain once an outcome
          // exists), so tombstoned/settled (flight, day) tuples must not be
          // re-verified forever. One free chain read saves the API call.
          const onChain = await client.readContract(oracleId, "get_flight_data", [
            client.symbolToScVal(flightId),
            client.u64ToScVal(dateSecs),
          ]);
          const onChainStatus = parseFlightStatus(onChain.status);
          if (
            onChainStatus !== FlightStatus.NotInitiated &&
            onChainStatus !== FlightStatus.Active
          ) {
            continue; // outcome recorded — nothing to authorize, ever
          }

          const apiData = await aeroApi.getFlightData(flightId, dateStr);

          if (apiData && apiData.cancelled) {
            // Cancellation signal: revoke first, record second. `close_sale`
            // is deliberately pause-exempt on-chain — it only removes
            // authorization — so the live sale window dies immediately even
            // while the oracle contract is paused, and it is safe to do on
            // the bare `cancelled` flag (fail closed).
            await closeIfLive(flightId, dateSecs, label, "cancelled");

            if (!isConfirmedCancellation(apiData)) {
              // "No longer tracked" without a corroborating status is not
              // proof of cancellation — never write the payout-minting
              // tombstone off it. The window stays closed (fail closed);
              // retry next cycle and surface for ops if it persists.
              console.warn(
                `[authorizer] ${label}: cancelled flag WITHOUT corroborating status ` +
                  `("${apiData.status}") — window closed, tombstone withheld. ` +
                  `If this persists, investigate manually.`
              );
              actions.push({ flight: label, skipped: `Uncorroborated cancellation (status "${apiData.status}")` });
              continue;
            }

            // Tombstone it (also deletes any remaining sale authorization
            // on-chain). Gate 2 above already guarantees the on-chain status
            // is NotInitiated or Active — no outcome recorded yet.
            console.log(`[authorizer] ${label}: cancelled — writing tombstone`);
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
            // A cancellation written for a REGISTERED flight (one with
            // buyers) is a pending outcome that blocks every LP entry/exit
            // until settled — drive it through classify + settle directly.
            // Skips unregistered tombstones (nothing listed to settle).
            await classifyAndSettleFlight(
              client,
              config,
              flightId,
              dateSecs,
              label,
              actions
            );
            continue;
          }

          if (!apiData || !apiData.scheduled_in) {
            // Unverifiable (no data, ambiguous candidates, or no schedule):
            // never authorize, and revoke an existing window rather than let
            // buyers purchase an instance the oracle cannot vouch for.
            await closeIfLive(flightId, dateSecs, label, "unverifiable");
            continue;
          }

          // Verified scheduled and not cancelled — open/refresh.
          await openOrRefresh(flightId, dateSecs, label);
        } catch (err) {
          console.error(`[authorizer] ${label}: Error — ${err}. Will retry next cycle.`);
          actions.push({ flight: label, error: String(err) });
        }
      }

      // FAR WINDOW — days 3..horizon, from the batched pair fetch above.
      if (horizonDays <= NEAR_WINDOW_DAYS) continue;
      if (!route) continue; // no pair to look up (shouldn't happen)
      const pairKey = `${route.origin}|${route.destination}`;

      for (let offset = NEAR_WINDOW_DAYS + 1; offset <= horizonDays; offset++) {
        const { dateSecs, dateStr } = dayDate(todayIndex + offset);
        const label = `${flightId}@${dateStr}`;

        try {
          if (farUnknown.has(`${pairKey}|${dateStr}`)) {
            // Schedules call failed — no action; live windows lapse on
            // their own within the ≤6h validity.
            continue;
          }
          const count = farCounts.get(`${flightId}|${dateStr}`) ?? 0;
          if (count === 1) {
            await openOrRefresh(flightId, dateSecs, label);
          } else if (count === 0) {
            await closeIfLive(flightId, dateSecs, label, "not in published schedule");
          } else {
            console.warn(
              `[authorizer] ${label}: ${count} schedule instances on one day — ambiguous, failing closed.`
            );
            await closeIfLive(flightId, dateSecs, label, "ambiguous schedule");
          }
        } catch (err) {
          console.error(`[authorizer] ${label}: Error — ${err}. Will retry next cycle.`);
          actions.push({ flight: label, error: String(err) });
        }
      }
    }

    console.log(`[authorizer] Done. ${actions.length} action(s).`);
    return {
      timestamp: new Date().toISOString(),
      job: "sale_authorizer",
      duration_ms: Date.now() - start,
      success: true,
      actions,
    };
  } catch (err) {
    console.error(`[authorizer] Fatal error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "sale_authorizer",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
      actions,
    };
  }
}

/**
 * Split a flight ident into airline designator + flight number for the
 * /schedules filters. Accepts ICAO ("UAL100") and IATA ("UA100") style
 * idents; returns null for anything else (registration-style idents etc.).
 */
export function parseFlightIdent(
  ident: string
): { airline: string; flightNumber: string } | null {
  const m = ident.match(/^([A-Z]{2,3})(\d{1,4})$/);
  if (!m) return null;
  return { airline: m[1], flightNumber: m[2] };
}

/** Current sale-authorization expiry, or null when no window is live. */
async function readSaleExpiry(
  client: SorobanClient,
  oracleId: string,
  flightId: string,
  dateSecs: bigint
): Promise<bigint | null> {
  const raw = await client.readContract(oracleId, "get_sale_auth", [
    client.symbolToScVal(flightId),
    client.u64ToScVal(dateSecs),
  ]);
  if (raw === null || raw === undefined) return null;
  return BigInt(raw);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
