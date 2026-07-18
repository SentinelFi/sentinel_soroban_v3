import { SorobanClient } from "../soroban_client";
import { AeroApiClient } from "../aeroapi_client";
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

/**
 * Cron #0 — SaleAuthorizer (every 2 hours, offset from the fetcher)
 *
 * The on-chain purchase gate requires a live, unexpired sale authorization
 * from the oracle: absence of an on-chain outcome proves nothing about the
 * real flight (a publicly cancelled flight looks identical to a valid
 * unreported one until the cancellation write lands), so insurability is
 * attested affirmatively instead of inferred. This job is that attestation
 * loop. For every enabled flight number and every day inside the sale
 * horizon it:
 *
 * 1. asks AeroAPI whether the (flight, day) instance is scheduled;
 * 2. the moment a cancellation is visible, revokes any live sale window
 *    with the pause-exempt `close_sale` FIRST (so the flight stops being
 *    purchasable even if the oracle contract is paused), then pushes the
 *    `set_cancelled` tombstone (which blocks purchases permanently and
 *    deletes any remaining authorization on-chain);
 * 3. closes the sale window when the instance becomes unverifiable
 *    (no data / ambiguous candidates) — fail closed, never guess;
 * 4. otherwise opens/refreshes the window with a bounded expiry
 *    (`min(flight date, now + validity)`, validity capped on-chain at 24h).
 *
 * If this job stops running, every window lapses within its validity and
 * sales halt protocol-wide — that is the intended fail-safe, not a bug.
 *
 * Vercel port difference vs the executor: the flight list is DERIVED from
 * config/routes.testnet.json (enabled routes) instead of the
 * SALE_AUTH_FLIGHT_IDS env var — one source of truth with the governance
 * whitelist. The horizon likewise defaults to the file's sale_horizon_days
 * (SALE_AUTH_HORIZON_DAYS env still overrides).
 */
export async function run(config: Config): Promise<RunLogEntry> {
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
        "[authorizer] No enabled routes in config/routes.testnet.json — no sale windows will be opened and all purchases fail closed."
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
      `[authorizer] Attesting ${flightIds.length} flight number(s) over ${horizonDays} day(s)...`
    );

    for (const flightId of flightIds) {
      // Day 0 is skipped: the controller's min-lead cutoff already blocks
      // same-day purchases, so there is nothing to authorize.
      for (let offset = 1; offset <= horizonDays; offset++) {
        const dayIndex = todayIndex + offset;
        const dateSecs = BigInt(dayIndex * SECONDS_PER_DAY);
        const dateStr = new Date(dayIndex * SECONDS_PER_DAY * 1000)
          .toISOString()
          .slice(0, 10);
        const label = `${flightId}@${dateStr}`;

        try {
          const apiData = await aeroApi.getFlightData(flightId, dateStr);

          if (apiData && apiData.cancelled) {
            // Publicly cancelled: revoke first, record second. `close_sale`
            // is deliberately pause-exempt on-chain — it only removes
            // authorization — so the live sale window dies immediately even
            // while the oracle contract is paused. The pause-gated
            // `set_cancelled` tombstone that follows can fail during an
            // incident; ordering the calls this way means that failure
            // leaves no purchasable window behind (the old order did: a
            // failed tombstone write kept the authorization alive until the
            // next successful retry or its expiry).
            const liveExpiry = await readSaleExpiry(client, oracleId, flightId, dateSecs);
            if (liveExpiry !== null) {
              console.log(`[authorizer] ${label}: cancelled — closing sale window first`);
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
              actions.push({ flight: label, transition: "sale closed (cancelled)" });
            }

            // Tombstone it (also deletes any remaining sale authorization
            // on-chain) unless an outcome is already recorded.
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
