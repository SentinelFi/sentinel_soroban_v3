import { SorobanClient } from "../soroban_client";
import { AeroApiClient } from "../aeroapi_client";
import { parseFlightStatus } from "../status";
import {
  FlightStatus,
  type ActiveFlight,
  type Config,
  type RunLogEntry,
  type FetcherAction,
} from "../types";

const ONE_HOUR_SECS = 3600n;

/**
 * Cron #1 — FlightDataFetcher (every 2 hours)
 *
 * 1. Read active flights from OracleAggregator
 * 2. For NotInitiated flights: call AeroAPI; a cancellation is pushed
 *    immediately (set_cancelled), otherwise scheduled arrival → set_estimated_arrival
 * 3. For Active flights: call AeroAPI every cycle; a cancellation is pushed
 *    immediately (set_cancelled), landed resolution waits for ETA + 1hr buffer → set_landed
 *
 * Cancellations must reach the chain in the same cycle they become visible,
 * regardless of lifecycle stage: the on-chain purchase gate can only reject
 * buyers once the oracle records the cancellation, and every purchase of an
 * already-cancelled flight is a guaranteed claim against the vault. Deferring
 * the check until after the ETA buffer would leave such a flight purchasable
 * until well past its scheduled arrival.
 */
export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  let activeFlightCount = 0;

  try {
    const client = new SorobanClient(config);
    const aeroApi = new AeroApiClient(config);
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
          // Step A: Fetch scheduled arrival time
          console.log(`[fetcher] ${flight.flight_id}: NotInitiated → fetching ETA from AeroAPI...`);

          const apiData = await aeroApi.getFlightData(flight.flight_id, dateStr);
          if (!apiData) {
            console.log(`[fetcher] ${flight.flight_id}: No AeroAPI data, skipping.`);
            actions.push({ flight: flight.flight_id, skipped: "No AeroAPI data" });
            continue;
          }

          if (apiData.cancelled) {
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
          // Step B: Fetch every cycle. Cancellation is checked FIRST, before
          // the ETA gate — a flight can be cancelled long before its scheduled
          // arrival, and the purchase gate stays open until the oracle records
          // it. Only the landed resolution waits for ETA + 1hr.
          console.log(`[fetcher] ${flight.flight_id}: Active → fetching current status...`);

          const apiData = await aeroApi.getFlightData(flight.flight_id, dateStr);
          if (!apiData) {
            console.log(`[fetcher] ${flight.flight_id}: No AeroAPI data, will retry next cycle.`);
            actions.push({ flight: flight.flight_id, skipped: "No AeroAPI data, will retry" });
            continue;
          }

          if (apiData.cancelled) {
            // Cancelled — use the boolean flag, not the status string
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
