import { SorobanClient } from "./soroban_client.js";
import { AeroApiClient } from "./aeroapi_client.js";
import {
  FlightStatus,
  type Config,
  type RunLogEntry,
  type FetcherAction,
} from "./types.js";

const SECONDS_PER_DAY = 86_400;

/**
 * Cron #0 — SaleAuthorizer (every 2 hours, offset from the fetcher)
 *
 * The on-chain purchase gate requires a live, unexpired sale authorization
 * from the oracle: absence of an on-chain outcome proves nothing about the
 * real flight (a publicly cancelled flight looks identical to a valid
 * unreported one until the cancellation write lands), so insurability is
 * attested affirmatively instead of inferred. This job is that attestation
 * loop. For every configured flight number and every day inside the sale
 * horizon it:
 *
 * 1. asks AeroAPI whether the (flight, day) instance is scheduled;
 * 2. pushes `set_cancelled` the moment a cancellation is visible — the
 *    tombstone blocks purchases instantly, without waiting for the current
 *    authorization to lapse (`set_cancelled` also deletes it on-chain);
 * 3. closes the sale window when the instance becomes unverifiable
 *    (no data / ambiguous candidates) — fail closed, never guess;
 * 4. otherwise opens/refreshes the window with a bounded expiry
 *    (`min(flight date, now + validity)`, validity capped on-chain at 24h).
 *
 * If this job stops running, every window lapses within its validity and
 * sales halt protocol-wide — that is the intended fail-safe, not a bug.
 *
 * Ops notes:
 * - SALE_AUTH_FLIGHT_IDS must track the governance route whitelist; a
 *   whitelisted route absent from this list is simply never sellable.
 * - API volume per run is |flights| x horizon days. Days beyond the
 *   provider's schedule visibility return no data and stay closed, so the
 *   effective sale horizon is min(configured horizon, provider visibility).
 */
export async function runSaleAuthorizer(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];

  try {
    if (config.saleAuthFlightIds.length === 0) {
      console.warn(
        "[authorizer] SALE_AUTH_FLIGHT_IDS is empty — no sale windows will be opened and all purchases fail closed."
      );
      return {
        timestamp: new Date().toISOString(),
        job: "sale_authorizer",
        duration_ms: Date.now() - start,
        success: true,
        actions,
      };
    }

    const client = new SorobanClient(config);
    const aeroApi = new AeroApiClient(config);
    const oracleId = config.oracleAggregatorId;
    const oraclePublicKey = client.publicKeyFromSecret(config.oracleSecretKey);

    const nowSecs = Math.floor(Date.now() / 1000);
    const todayIndex = Math.floor(nowSecs / SECONDS_PER_DAY);

    console.log(
      `[authorizer] Attesting ${config.saleAuthFlightIds.length} flight number(s) over ${config.saleAuthHorizonDays} day(s)...`
    );

    for (const flightId of config.saleAuthFlightIds) {
      // Day 0 is skipped: the controller's min-lead cutoff already blocks
      // same-day purchases, so there is nothing to authorize.
      for (let offset = 1; offset <= config.saleAuthHorizonDays; offset++) {
        const dayIndex = todayIndex + offset;
        const dateSecs = BigInt(dayIndex * SECONDS_PER_DAY);
        const dateStr = new Date(dayIndex * SECONDS_PER_DAY * 1000)
          .toISOString()
          .slice(0, 10);
        const label = `${flightId}@${dateStr}`;

        try {
          const apiData = await aeroApi.getFlightData(flightId, dateStr);

          if (apiData && apiData.cancelled) {
            // Publicly cancelled. Tombstone it (also deletes any live sale
            // authorization on-chain) unless an outcome is already recorded.
            const data = await client.readContract(oracleId, "get_flight_data", [
              client.symbolToScVal(flightId),
              client.u64ToScVal(dateSecs),
            ]);
            const status = parseFlightStatus(data.status);
            if (
              status === FlightStatus.NotInitiated ||
              status === FlightStatus.Active
            ) {
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
            }
            continue;
          }

          const currentExpiry = await readSaleExpiry(
            client,
            oracleId,
            flightId,
            dateSecs
          );

          if (!apiData || !apiData.scheduled_in) {
            // Unverifiable (no data, ambiguous candidates, or no schedule):
            // never authorize, and revoke an existing window rather than let
            // buyers purchase an instance the oracle cannot vouch for.
            if (currentExpiry !== null && currentExpiry > BigInt(nowSecs)) {
              console.log(`[authorizer] ${label}: unverifiable — closing sale window`);
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
              actions.push({ flight: label, transition: "sale closed (unverifiable)" });
            }
            continue;
          }

          // Verified scheduled and not cancelled — open/refresh, but skip the
          // write while the current window still has most of its life left.
          const expiresAt = min(
            dateSecs,
            BigInt(nowSecs + config.saleAuthValiditySecs)
          );
          if (
            currentExpiry !== null &&
            currentExpiry - BigInt(nowSecs) >
              BigInt(Math.floor(config.saleAuthValiditySecs / 2)) &&
            currentExpiry >= expiresAt
          ) {
            continue; // still fresh
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

// Mirrors the fetcher's tolerant enum decoding (index / name / array / object).
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
  return FlightStatus.NotInitiated;
}
