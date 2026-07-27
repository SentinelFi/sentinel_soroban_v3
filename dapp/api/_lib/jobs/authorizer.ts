import { SorobanClient } from "../soroban_client";
import { AeroApiClient, isConfirmedCancellation } from "../aeroapi_client";
import { classifyAndSettleFlight } from "../targeted_settlement";
import { parseFlightStatus } from "../status";
import { enabledFlightIds, loadRoutesConfig } from "../routes_config";
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

/** Optional dependency injection seam — tests pass fakes, production omits. */
export interface AuthorizerDeps {
  soroban?: SorobanClient;
  aero?: AeroApiClient;
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
 * burned a guaranteed-failing call per flight per day out there). Instead,
 * one /schedules call per ≤20-day chunk (filtered by airline + flight
 * number + route origin/destination) attests which days the airline has
 * published the flight for:
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
 * day) has a recorded outcome. Steady state ≈ 2 /flights calls per
 * ~validity/2 (default 3h) per flight + ceil((horizon−2)/20) /schedules
 * calls per run — for a 90-day horizon ~7 calls per refresh cycle instead
 * of the old 90 per run.
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
    const flightIds = enabledFlightIds(routesConfig);
    const horizonDays =
      config.saleAuthHorizonDays > 0
        ? config.saleAuthHorizonDays
        : routesConfig.saleHorizonDays;

    if (flightIds.length === 0) {
      console.warn(
        "[authorizer] No enabled routes in the routes config — no sale windows will be opened and all purchases fail closed."
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

    // ── Per-flight attestation ─────────────────────────────────────────

    for (const flightId of flightIds) {
      const route = routesConfig.routes.find((r) => r.enabled && r.flight_id === flightId);

      // NEAR WINDOW — days 1..2, live tracking data.
      // Day 0 is skipped: the controller's min-lead cutoff already blocks
      // same-day purchases, so there is nothing to authorize.
      const nearEnd = Math.min(NEAR_WINDOW_DAYS, horizonDays);
      for (let offset = 1; offset <= nearEnd; offset++) {
        const { dateSecs, dateStr } = dayDate(todayIndex + offset);
        const label = `${flightId}@${dateStr}`;

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

      // FAR WINDOW — days 3..horizon, published schedules.
      if (horizonDays <= NEAR_WINDOW_DAYS) continue;

      const parsed = parseFlightIdent(flightId);
      if (!parsed) {
        // Without airline + flight number the schedules filter can't be
        // built. The near window still attests days 1..2; far days simply
        // stay closed (fail closed) until the ident is fixed in the routes
        // file.
        console.warn(
          `[authorizer] ${flightId}: cannot derive airline/flight number from ident — ` +
            `far-horizon attestation skipped (days 3..${horizonDays} stay closed).`
        );
        actions.push({ flight: flightId, skipped: "Unparsable ident — far horizon closed" });
        continue;
      }

      // One /schedules call per ≤20-day chunk. Map: dateStr → instance count.
      // A chunk whose call failed contributes NO entries and its days are
      // marked unknown (no action taken on them this run).
      const scheduledCount = new Map<string, number>();
      const unknownDays = new Set<string>();

      let chunkStart = todayIndex + NEAR_WINDOW_DAYS + 1;
      const lastDay = todayIndex + horizonDays;
      while (chunkStart <= lastDay) {
        const chunkEnd = Math.min(chunkStart + SCHEDULE_CHUNK_DAYS - 1, lastDay);
        const startStr = dayDate(chunkStart).dateStr;
        // date_end is exclusive — pass the day AFTER the last wanted day.
        const endStr = dayDate(chunkEnd + 1).dateStr;

        const schedules = await aeroApi.getSchedules(startStr, endStr, {
          airline: parsed.airline,
          flightNumber: parsed.flightNumber,
          origin: route?.origin,
          destination: route?.destination,
        });

        if (!schedules) {
          for (let d = chunkStart; d <= chunkEnd; d++) {
            unknownDays.add(dayDate(d).dateStr);
          }
        } else {
          for (const entry of schedules.scheduled ?? []) {
            const day = (entry.scheduled_out ?? "").slice(0, 10);
            if (day) scheduledCount.set(day, (scheduledCount.get(day) ?? 0) + 1);
          }
        }
        chunkStart = chunkEnd + 1;
      }

      for (let offset = NEAR_WINDOW_DAYS + 1; offset <= horizonDays; offset++) {
        const { dateSecs, dateStr } = dayDate(todayIndex + offset);
        const label = `${flightId}@${dateStr}`;

        try {
          if (unknownDays.has(dateStr)) {
            // Schedules call failed — no action; live windows lapse on
            // their own within the ≤6h validity.
            continue;
          }
          const count = scheduledCount.get(dateStr) ?? 0;
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
