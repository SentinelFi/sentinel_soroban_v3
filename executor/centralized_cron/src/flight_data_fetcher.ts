import { SorobanClient } from "./soroban_client.js";
import { AeroApiClient } from "./aeroapi_client.js";
import {
  FlightStatus,
  type ActiveFlight,
  type Config,
  type RunLogEntry,
  type FetcherAction,
} from "./types.js";

const ONE_HOUR_SECS = 3600n;

/**
 * Cron #1 — FlightDataFetcher (every 2 hours)
 *
 * 1. Read active flights from OracleAggregator
 * 2. For NotInitiated flights: call AeroAPI for scheduled arrival → set_estimated_arrival
 * 3. For Active flights (past ETA + 1hr buffer): call AeroAPI for actual status → set_landed / set_cancelled
 */
export async function runFlightDataFetcher(config: Config): Promise<RunLogEntry> {
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
          // Step B: Check if flight should have landed (ETA + 1hr buffer)
          if (estimatedArrival + ONE_HOUR_SECS > nowSecs) {
            console.log(`[fetcher] ${flight.flight_id}: Active but ETA+1hr not passed yet, skipping.`);
            actions.push({ flight: flight.flight_id, skipped: "ETA+1hr not passed" });
            continue;
          }

          console.log(`[fetcher] ${flight.flight_id}: Active, ETA+1hr passed → fetching actual status...`);

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

// Map enum index to FlightStatus (matches on-chain enum order)
const STATUS_BY_INDEX: FlightStatus[] = [
  FlightStatus.NotInitiated,
  FlightStatus.Active,
  FlightStatus.Landed,
  FlightStatus.Cancelled,
  FlightStatus.ToBeSettledOnTime,
  FlightStatus.ToBeSettledDelayed,
  FlightStatus.ToBeSettledCancelled,
  FlightStatus.Settled,
];

/**
 * scValToNative returns enum variants in different shapes depending on
 * SDK version: an index (number), a variant name (string), a one-element
 * array, or an object whose key is the variant. Handle all four.
 */
function parseFlightStatus(raw: any): FlightStatus {
  if (typeof raw === "number") {
    return STATUS_BY_INDEX[raw] ?? FlightStatus.NotInitiated;
  }
  if (typeof raw === "string") {
    return raw as FlightStatus;
  }
  if (Array.isArray(raw)) {
    return raw[0] as FlightStatus;
  }
  if (typeof raw === "object" && raw !== null) {
    const keys = Object.keys(raw);
    if (keys.length > 0) return keys[0] as FlightStatus;
  }
  console.warn(`[fetcher] Unknown status format: ${JSON.stringify(raw)}, defaulting to NotInitiated`);
  return FlightStatus.NotInitiated;
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
