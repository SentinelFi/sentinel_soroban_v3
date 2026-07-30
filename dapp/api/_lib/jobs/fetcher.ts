import { SorobanClient } from "../soroban_client";
import { AeroApiClient, isConfirmedCancellation, isConfirmedDiversion } from "../aeroapi_client";
import { classifyAndSettleFlight } from "../targeted_settlement";
import { parseFlightStatus } from "../status";
import { logFlightOutcome } from "../outcome_log";
import {
  FlightStatus,
  type ActiveFlight,
  type Config,
  type RunLogEntry,
  type FetcherAction,
} from "../types";

const ONE_HOUR_SECS = 3600n;
// AeroAPI /flights/{ident} visibility: start/end must be within 10 days past
// and 2 days future — queries outside that window are a 400 and can never
// return data. Both bounds gate our API spend.
const VISIBILITY_FUTURE_SECS = 2n * 86_400n;
const VISIBILITY_PAST_SECS = 10n * 86_400n;

/** Optional dependency injection seam — tests pass fakes, production omits. */
export interface FetcherDeps {
  soroban?: SorobanClient;
  aero?: AeroApiClient;
}

/**
 * Cron #1 — FlightDataFetcher (every 2 hours)
 *
 * 1. Read active flights from OracleAggregator
 * 2. For NotInitiated flights INSIDE AeroAPI's schedule-visibility window
 *    (flight date ≤ now + 2d): call AeroAPI; a corroborated cancellation is
 *    pushed immediately (set_cancelled), otherwise scheduled arrival →
 *    set_estimated_arrival. Flights further out are skipped WITHOUT an API
 *    call — /flights/{ident} cannot see past 2 days of future schedule, so
 *    the call could never succeed.
 * 3. For Active flights INSIDE the watch window (now ≥ ETA − FETCHER_WATCH_SECS,
 *    default 6h): call AeroAPI each cycle; a corroborated cancellation is
 *    pushed immediately, landed resolution waits for ETA + 1hr buffer →
 *    set_landed. Before the watch window opens the flight is skipped WITHOUT
 *    an API call — nothing before departure needs a data point except the
 *    pre-departure cancellation check, which the watch window covers.
 *
 * Call-economy invariant: a flight costs API calls only near its own
 * departure/arrival — ~1 call at T-2d (ETA write), then ~3-6 calls inside
 * the watch window until landing resolves. A flight bought 60 days out
 * costs ZERO calls for 58 days.
 *
 * Cancellations must reach the chain in the same cycle they become visible
 * WITHIN the watched phases: the on-chain purchase gate can only reject
 * buyers once the oracle records the cancellation, and every purchase of an
 * already-cancelled flight is a guaranteed claim against the vault. (Sale
 * windows are the primary purchase gate and never extend past the departure
 * day, so the watch-window gap does not extend purchasability.)
 *
 * Cancellation corroboration: AeroAPI's `cancelled` flag alone means "no
 * longer tracked", which is NOT always an airline cancellation. The
 * irreversible, payout-minting set_cancelled tombstone is only written when
 * the status text corroborates it (isConfirmedCancellation); a bare flag is
 * logged and retried — if it persists, it surfaces in run logs for ops.
 *
 * Diverted flights PAY AS CANCELLATIONS (product policy): the insured
 * journey to the filed destination did not happen as sold, and the on-chain
 * Cancelled outcome already moves exactly the right money (full payoff per
 * buyer) — no contract change needed. A diverted leg is never attested as
 * landed (its actual_in is the DIVERSION airport's arrival); once the
 * diversion is corroborated (isConfirmedDiversion) the fetcher writes
 * set_cancelled instead. An uncorroborated diverted flag is retried, same
 * as cancellations.
 *
 * After every outcome write the fetcher drives the exact tuple through
 * classify_flight + settle_flight (targeted settlement) so the vault's
 * settlement barrier lifts in seconds instead of waiting for sweeps.
 */
export async function run(config: Config, deps: FetcherDeps = {}): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  let activeFlightCount = 0;

  try {
    const client = deps.soroban ?? new SorobanClient(config);
    const aeroApi = deps.aero ?? new AeroApiClient(config);
    const oracleId = config.oracleAggregatorId;
    const oraclePublicKey = client.publicKeyFromSecret(config.oracleSecretKey);

    console.log("[fetcher] Starting flight data fetch...");

    // 1. Read active flights
    const rawFlights = await client.readContract(oracleId, "get_active_flights");

    if (!rawFlights || rawFlights.length === 0) {
      console.log("[fetcher] No active flights.");
      return {
        timestamp: new Date().toISOString(),
        job: "fetcher",
        duration_ms: Date.now() - start,
        success: true,
        active_flights: 0,
        actions,
      };
    }

    const flights: ActiveFlight[] = rawFlights.map((f: [string, bigint]) => ({
      flight_id: f[0],
      date: f[1],
    }));
    activeFlightCount = flights.length;

    console.log(`[fetcher] ${flights.length} active flight(s): ${flights.map((f) => f.flight_id).join(", ")}`);

    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const watchSecs = BigInt(config.fetcherWatchSecs);

    for (const flight of flights) {
      try {
        // 2. Read current flight data from oracle
        const data = await client.readContract(oracleId, "get_flight_data", [
          client.symbolToScVal(flight.flight_id),
          client.u64ToScVal(flight.date),
        ]);

        const status = parseFlightStatus(data.status);
        const estimatedArrival = BigInt(data.estimated_arrival_time ?? 0);

        // Convert date (u64, yyyymmdd or unix) to a date string for AeroAPI
        const dateStr = dateToString(flight.date);

        if (status === FlightStatus.NotInitiated) {
          // Phase gate A — schedule visibility. /flights/{ident} cannot see
          // beyond 2 days of future schedule; querying earlier burns a call
          // that can never succeed. Skip WITHOUT calling the API.
          if (flight.date > nowSecs + VISIBILITY_FUTURE_SECS) {
            actions.push({ flight: flight.flight_id, skipped: "Outside AeroAPI visibility (ETA fetch begins T-2d)" });
            continue;
          }
          // Phase gate B — history horizon. Past date+10d the API can no
          // longer return the flight; stop spending calls and let the
          // stale-void timeout reclaim it (classify_flights, day 14).
          if (nowSecs > flight.date + VISIBILITY_PAST_SECS) {
            actions.push({ flight: flight.flight_id, skipped: "Past AeroAPI history window — awaiting stale-void" });
            continue;
          }

          // Step A: Fetch scheduled arrival time
          console.log(`[fetcher] ${flight.flight_id}: NotInitiated → fetching ETA from AeroAPI...`);

          const apiData = await aeroApi.getFlightData(flight.flight_id, dateStr);
          if (!apiData) {
            console.log(`[fetcher] ${flight.flight_id}: No AeroAPI data, skipping.`);
            actions.push({ flight: flight.flight_id, skipped: "No AeroAPI data" });
            continue;
          }

          if (apiData.cancelled) {
            if (!isConfirmedCancellation(apiData)) {
              // Tracking-lost, not a corroborated cancellation — never
              // tombstone (that pays every buyer) off the bare flag.
              console.warn(
                `[fetcher] ${flight.flight_id}: cancelled flag WITHOUT corroborating status ` +
                  `("${apiData.status}") — tracking gap? Skipping tombstone; will retry. ` +
                  `If this persists, investigate manually.`
              );
              actions.push({ flight: flight.flight_id, skipped: `Uncorroborated cancellation (status "${apiData.status}")` });
              continue;
            }
            // Already cancelled before ever going Active — push it now so the
            // purchase gate closes; never store an ETA for a dead flight.
            console.log(`[fetcher] ${flight.flight_id}: Cancelled (pre-active)`);
            await client.invokeContract(
              oracleId,
              "set_cancelled",
              [
                client.addressToScVal(oraclePublicKey),
                client.symbolToScVal(flight.flight_id),
                client.u64ToScVal(flight.date),
              ],
              config.oracleSecretKey
            );
            console.log(`[fetcher] ${flight.flight_id}: NotInitiated → Cancelled ✓`);
            actions.push({ flight: flight.flight_id, transition: "NotInitiated → Cancelled" });
            await logFlightOutcome({ flightId: flight.flight_id, dateUnix: flight.date, outcome: "cancelled", delayMinutes: null });
            // A written outcome engages the vault's settlement barrier —
            // drive this exact tuple through classify + settle right away.
            await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
            continue;
          }

          if (apiData.diverted) {
            // Diverted before the ETA was ever written (day-of purchase +
            // early diversion). Policy: pays as cancellation once
            // corroborated; never store an ETA for a diverted flight.
            if (!isConfirmedDiversion(apiData)) {
              console.warn(
                `[fetcher] ${flight.flight_id}: diverted flag not yet corroborated ` +
                  `(status "${apiData.status}") — will retry.`
              );
              actions.push({ flight: flight.flight_id, skipped: `Uncorroborated diversion (status "${apiData.status}")` });
              continue;
            }
            console.log(`[fetcher] ${flight.flight_id}: DIVERTED (pre-active) → pays as cancellation (policy)`);
            await client.invokeContract(
              oracleId,
              "set_cancelled",
              [
                client.addressToScVal(oraclePublicKey),
                client.symbolToScVal(flight.flight_id),
                client.u64ToScVal(flight.date),
              ],
              config.oracleSecretKey
            );
            actions.push({ flight: flight.flight_id, transition: "NotInitiated → Cancelled (diverted)" });
            await logFlightOutcome({ flightId: flight.flight_id, dateUnix: flight.date, outcome: "diverted", delayMinutes: null });
            await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
            continue;
          }

          const eta = aeroApi.parseTimestamp(apiData.scheduled_in);
          if (eta === 0n) {
            console.log(`[fetcher] ${flight.flight_id}: No scheduled_in, skipping.`);
            actions.push({ flight: flight.flight_id, skipped: "No scheduled_in" });
            continue;
          }

          // Submit: set_estimated_arrival(oracle, flight_id, date, eta)
          console.log(`[fetcher] ${flight.flight_id}: Setting estimated arrival = ${eta}`);
          await client.invokeContract(
            oracleId,
            "set_estimated_arrival",
            [
              client.addressToScVal(oraclePublicKey),
              client.symbolToScVal(flight.flight_id),
              client.u64ToScVal(flight.date),
              client.u64ToScVal(eta),
            ],
            config.oracleSecretKey
          );
          console.log(`[fetcher] ${flight.flight_id}: NotInitiated → Active ✓`);
          actions.push({ flight: flight.flight_id, transition: "NotInitiated → Active" });
        } else if (status === FlightStatus.Active) {
          // Phase gate C — watch window. Between the ETA write (T-2d) and
          // ETA − watchSecs there is nothing to fetch: the flight hasn't
          // departed, and the pre-departure cancellation check lives inside
          // the watch window. Skip WITHOUT calling the API.
          if (estimatedArrival > 0n && nowSecs + watchSecs < estimatedArrival) {
            actions.push({ flight: flight.flight_id, skipped: "Before watch window (ETA − watch)" });
            continue;
          }
          // Phase gate D — history horizon (data gap: ETA long past, still
          // no outcome). Past visibility the API cannot answer; stop calling
          // and let the active-void timeout reclaim it.
          if (estimatedArrival > 0n && nowSecs > estimatedArrival + VISIBILITY_PAST_SECS) {
            actions.push({ flight: flight.flight_id, skipped: "Past AeroAPI history window — awaiting active-void" });
            continue;
          }

          // Step B: inside the watch window, fetch every cycle. Cancellation
          // is checked FIRST, before the ETA gate — a flight can be cancelled
          // before departure, and the tombstone must land the same cycle.
          console.log(`[fetcher] ${flight.flight_id}: Active → fetching current status...`);

          const apiData = await aeroApi.getFlightData(flight.flight_id, dateStr);
          if (!apiData) {
            console.log(`[fetcher] ${flight.flight_id}: No AeroAPI data, will retry next cycle.`);
            actions.push({ flight: flight.flight_id, skipped: "No AeroAPI data, will retry" });
            continue;
          }

          if (apiData.cancelled) {
            if (!isConfirmedCancellation(apiData)) {
              console.warn(
                `[fetcher] ${flight.flight_id}: cancelled flag WITHOUT corroborating status ` +
                  `("${apiData.status}") — tracking gap? Skipping tombstone; will retry. ` +
                  `If this persists, investigate manually.`
              );
              actions.push({ flight: flight.flight_id, skipped: `Uncorroborated cancellation (status "${apiData.status}")` });
              continue;
            }
            console.log(`[fetcher] ${flight.flight_id}: Cancelled`);
            await client.invokeContract(
              oracleId,
              "set_cancelled",
              [
                client.addressToScVal(oraclePublicKey),
                client.symbolToScVal(flight.flight_id),
                client.u64ToScVal(flight.date),
              ],
              config.oracleSecretKey
            );
            console.log(`[fetcher] ${flight.flight_id}: Active → Cancelled ✓`);
            actions.push({ flight: flight.flight_id, transition: "Active → Cancelled" });
            await logFlightOutcome({ flightId: flight.flight_id, dateUnix: flight.date, outcome: "cancelled", delayMinutes: null });
            await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
          } else if (apiData.diverted) {
            // POLICY: diverted pays as cancellation. A diverted flight's
            // actual_in is the diversion airport's gate arrival — never
            // attest it as a normal landing. Once corroborated, write the
            // same Cancelled outcome as an airline cancellation: on-chain
            // it moves exactly the payout the policy owes (full payoff per
            // buyer), with no contract change.
            if (!isConfirmedDiversion(apiData)) {
              console.warn(
                `[fetcher] ${flight.flight_id}: diverted flag not yet corroborated ` +
                  `(status "${apiData.status}") — will retry.`
              );
              actions.push({ flight: flight.flight_id, skipped: `Uncorroborated diversion (status "${apiData.status}")` });
              continue;
            }
            console.log(`[fetcher] ${flight.flight_id}: DIVERTED (status "${apiData.status}") → pays as cancellation (policy)`);
            await client.invokeContract(
              oracleId,
              "set_cancelled",
              [
                client.addressToScVal(oraclePublicKey),
                client.symbolToScVal(flight.flight_id),
                client.u64ToScVal(flight.date),
              ],
              config.oracleSecretKey
            );
            console.log(`[fetcher] ${flight.flight_id}: Active → Cancelled (diverted) ✓`);
            actions.push({ flight: flight.flight_id, transition: "Active → Cancelled (diverted)" });
            await logFlightOutcome({ flightId: flight.flight_id, dateUnix: flight.date, outcome: "diverted", delayMinutes: null });
            await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
          } else if (estimatedArrival + ONE_HOUR_SECS > nowSecs) {
            // Not cancelled and not yet due — landed resolution waits.
            console.log(`[fetcher] ${flight.flight_id}: Active, not cancelled, ETA+1hr not passed yet.`);
            actions.push({ flight: flight.flight_id, skipped: "ETA+1hr not passed" });
          } else if (apiData.actual_in) {
            // Landed — actual_in is non-null only after gate arrival.
            // Don't match on status string ("Landed", "Arrived / Gate Arrival", etc.)
            const actualArrival = aeroApi.parseTimestamp(apiData.actual_in);
            console.log(`[fetcher] ${flight.flight_id}: Landed at ${actualArrival} (status: "${apiData.status}")`);
            await client.invokeContract(
              oracleId,
              "set_landed",
              [
                client.addressToScVal(oraclePublicKey),
                client.symbolToScVal(flight.flight_id),
                client.u64ToScVal(flight.date),
                client.u64ToScVal(actualArrival),
              ],
              config.oracleSecretKey
            );
            console.log(`[fetcher] ${flight.flight_id}: Active → Landed ✓`);
            actions.push({ flight: flight.flight_id, transition: "Active → Landed" });
            // Gate delay vs the published schedule (the model's covered
            // event is scheduled-vs-actual, not vs our on-chain ETA).
            const scheduled = aeroApi.parseTimestamp(apiData.scheduled_in);
            const delayMin = scheduled > 0n ? Math.round(Number(actualArrival - scheduled) / 60) : null;
            await logFlightOutcome({
              flightId: flight.flight_id,
              dateUnix: flight.date,
              outcome: delayMin !== null && delayMin >= 180 ? "delayed" : "ontime",
              delayMinutes: delayMin,
            });
            await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
          } else {
            // Still in flight — no actual arrival yet
            console.log(`[fetcher] ${flight.flight_id}: Status "${apiData.status}", no actual_in yet. Will retry.`);
            actions.push({ flight: flight.flight_id, skipped: `Still ${apiData.status}` });
          }
        } else {
          // Already Landed/Cancelled/ToBeSettled*/Settled — skip
          console.log(`[fetcher] ${flight.flight_id}: Status ${status}, nothing to do.`);
          actions.push({ flight: flight.flight_id, skipped: `Already ${status}` });
        }
      } catch (err) {
        console.error(`[fetcher] ${flight.flight_id}: Error — ${err}. Will retry next cycle.`);
        actions.push({ flight: flight.flight_id, error: String(err) });
      }
    }

    console.log("[fetcher] Done.");
    return {
      timestamp: new Date().toISOString(),
      job: "fetcher",
      duration_ms: Date.now() - start,
      success: true,
      active_flights: activeFlightCount,
      actions,
    };
  } catch (err) {
    console.error(`[fetcher] Fatal error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "fetcher",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
      active_flights: activeFlightCount,
      actions,
    };
  }
}

/**
 * Convert a u64 date to a YYYY-MM-DD string.
 * Supports both unix timestamps and YYYYMMDD integer format.
 */
function dateToString(date: bigint): string {
  const num = Number(date);
  if (num > 19000000 && num < 30000000) {
    const s = String(num);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return new Date(num * 1000).toISOString().slice(0, 10);
}
