import { SorobanClient } from "../soroban_client";
import { AeroApiClient, isConfirmedCancellation, isConfirmedDiversion } from "../aeroapi_client";
import { classifyAndSettleFlight } from "../targeted_settlement";
import { parseFlightStatus } from "../status";
import { logFlightOutcome } from "../outcome_log";
import { readScheduledArrival } from "../flight_schedules";
import {
  FlightStatus,
  type ActiveFlight,
  type Config,
  type RunLogEntry,
  type FetcherAction,
} from "../types";

// AeroAPI /flights/{ident} visibility: start/end must be within 10 days past
// and 2 days future — queries outside that window are a 400 and can never
// return data. Past this horizon the classify sweep's stale-void timeout
// (day 14) reclaims the flight; spending calls there is pure waste.
const VISIBILITY_PAST_SECS = 10n * 86_400n;
// No settle hint anywhere (no DB row, no on-chain ETA): assume the flight
// arrived by the end of its departure day + a landing buffer. 30h past the
// UTC-midnight bucket covers any same-day departure's arrival.
const FALLBACK_ARRIVAL_AFTER_DATE_SECS = 30n * 3600n;
// OCA-M04: stop starting new flights past this run age. The cron's
// maxDuration is 300s; one flight's stacked 429 cooldowns must never push
// the function into the platform's hard kill mid-chain-write. Flights not
// reached are logged and picked up by the next sweep.
const RUN_BUDGET_MS = 240_000;

/** Optional dependency injection seam — tests pass fakes, production omits. */
export interface FetcherDeps {
  soroban?: SorobanClient;
  aero?: AeroApiClient;
}

/**
 * Cron #1 — the SETTLE SWEEP (every 2 hours).
 *
 * 2026-07-31 rework: the old fetcher's phase machinery (T−2d ETA write,
 * ETA−6h watch window, per-phase visibility gates) is gone. The public
 * promise is simply "insured flights settle autonomously within 24h of
 * their scheduled arrival", and this job is that promise:
 *
 * 1. Read the insured set from the oracle (get_active_flights — every
 *    purchase registers its flight, so this IS "flights someone paid for").
 * 2. Skip any flight before scheduled arrival + SETTLE_AFTER_ETA_SECS
 *    (default 5h) — ZERO API calls while a flight is in the future or in
 *    the air. The scheduled arrival comes from, in order: the on-chain
 *    ETA (a prior run already wrote it), the flight_schedules row the JIT
 *    sale-auth endpoint saved at buy time, or date + 30h as the no-hint
 *    fallback.
 * 3. Past the gate: ONE /flights call resolves the outcome —
 *      - corroborated cancellation → set_cancelled;
 *      - corroborated diversion    → set_cancelled (policy: a diverted
 *        journey pays as a cancellation — the insured trip to the filed
 *        destination did not happen; never attest its actual_in, that is
 *        the DIVERSION airport's arrival);
 *      - landed (actual_in set)    → set_estimated_arrival (the contract's
 *        forward-only machine requires NotInitiated → Active before
 *        Landed, and the delay math needs the schedule) + set_landed;
 *      - still en route / no data  → retry next tick (typically a heavy
 *        delay; the 2h cadence keeps the 24h promise with room to spare).
 *    The bare `cancelled` flag WITHOUT a corroborating status is a
 *    tracking gap, not an outcome — the payout-minting tombstone is never
 *    written from it (logged + retried; persistent cases surface to ops).
 *
 * After every outcome write the sweep drives the exact tuple through
 * classify_flight + settle_flight (targeted settlement) and appends the
 * flight_outcomes row (outcome + that day's actual weather at both
 * airports — the same API response, zero extra AeroAPI calls).
 *
 * Call economy: an insured flight costs ~1 API call in its lifetime here
 * (plus retries while a very late flight resolves), and nothing at all
 * until 5h past its scheduled arrival.
 */
export async function run(config: Config, deps: FetcherDeps = {}): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  let activeFlightCount = 0;

  try {
    const client = deps.soroban ?? new SorobanClient(config);
    const deadline = start + RUN_BUDGET_MS;
    const aeroApi = deps.aero ?? new AeroApiClient(config);
    aeroApi.setDeadline(deadline);
    const oracleId = config.oracleAggregatorId;
    const oraclePublicKey = client.publicKeyFromSecret(config.oracleSecretKey);

    console.log("[settle-sweep] Starting...");

    // 1. The insured set.
    const rawFlights = await client.readContract(oracleId, "get_active_flights");

    if (!rawFlights || rawFlights.length === 0) {
      console.log("[settle-sweep] No insured flights.");
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

    console.log(`[settle-sweep] ${flights.length} insured flight(s): ${flights.map((f) => f.flight_id).join(", ")}`);

    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const settleDelay = BigInt(config.settleAfterEtaSecs);

    for (const flight of flights) {
      if (Date.now() > deadline) {
        actions.push({ flight: flight.flight_id, skipped: "run time budget exhausted — deferred to next sweep" });
        continue;
      }
      try {
        const data = await client.readContract(oracleId, "get_flight_data", [
          client.symbolToScVal(flight.flight_id),
          client.u64ToScVal(flight.date),
        ]);

        const status = parseFlightStatus(data.status);
        if (status !== FlightStatus.NotInitiated && status !== FlightStatus.Active) {
          actions.push({ flight: flight.flight_id, skipped: `Already ${status}` });
          continue;
        }

        // 2. The timing gate — the ONLY thing that spends API calls.
        const onChainEta = BigInt(data.estimated_arrival_time ?? 0);
        const scheduledArrival =
          onChainEta > 0n
            ? onChainEta
            : ((await readScheduledArrival(flight.flight_id, flight.date)) ??
              flight.date + FALLBACK_ARRIVAL_AFTER_DATE_SECS);

        if (nowSecs < scheduledArrival + settleDelay) {
          actions.push({ flight: flight.flight_id, skipped: "Before scheduled arrival + settle delay" });
          continue;
        }
        // Data gap: past AeroAPI's history window the API cannot answer;
        // stop calling and let the stale-void timeout reclaim it.
        if (nowSecs > scheduledArrival + VISIBILITY_PAST_SECS) {
          actions.push({ flight: flight.flight_id, skipped: "Past AeroAPI history window — awaiting void" });
          continue;
        }

        // 3. Resolve the outcome.
        const dateStr = dateToString(flight.date);
        console.log(`[settle-sweep] ${flight.flight_id} ${dateStr}: past settle gate → fetching outcome...`);

        const apiData = await aeroApi.getFlightData(flight.flight_id, dateStr);
        if (!apiData) {
          console.log(`[settle-sweep] ${flight.flight_id}: No AeroAPI data, will retry next cycle.`);
          actions.push({ flight: flight.flight_id, skipped: "No AeroAPI data, will retry" });
          continue;
        }

        if (apiData.cancelled) {
          if (!isConfirmedCancellation(apiData)) {
            console.warn(
              `[settle-sweep] ${flight.flight_id}: cancelled flag WITHOUT corroborating status ` +
                `("${apiData.status}") — tracking gap? Skipping tombstone; will retry. ` +
                `If this persists, investigate manually.`
            );
            actions.push({ flight: flight.flight_id, skipped: `Uncorroborated cancellation (status "${apiData.status}")` });
            continue;
          }
          console.log(`[settle-sweep] ${flight.flight_id}: Cancelled`);
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
          actions.push({ flight: flight.flight_id, transition: `${status} → Cancelled` });
          await logFlightOutcome({ flightId: flight.flight_id, dateUnix: flight.date, outcome: "cancelled", delayMinutes: null });
          await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
          continue;
        }

        if (apiData.diverted) {
          if (!isConfirmedDiversion(apiData)) {
            console.warn(
              `[settle-sweep] ${flight.flight_id}: diverted flag not yet corroborated ` +
                `(status "${apiData.status}") — will retry.`
            );
            actions.push({ flight: flight.flight_id, skipped: `Uncorroborated diversion (status "${apiData.status}")` });
            continue;
          }
          console.log(`[settle-sweep] ${flight.flight_id}: DIVERTED (status "${apiData.status}") → pays as cancellation (policy)`);
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
          actions.push({ flight: flight.flight_id, transition: `${status} → Cancelled (diverted)` });
          await logFlightOutcome({ flightId: flight.flight_id, dateUnix: flight.date, outcome: "diverted", delayMinutes: null });
          await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
          continue;
        }

        if (!apiData.actual_in) {
          // Heavily delayed / still airborne — the 2h cadence retries.
          console.log(`[settle-sweep] ${flight.flight_id}: Status "${apiData.status}", no actual_in yet. Will retry.`);
          actions.push({ flight: flight.flight_id, skipped: `Still ${apiData.status}` });
          continue;
        }

        // Landed. The delay classification is scheduled-vs-actual per the
        // published schedule, so the schedule write and the landing write
        // come from the SAME response — one API call end to end.
        const scheduledIn = aeroApi.parseTimestamp(apiData.scheduled_in);
        const actualArrival = aeroApi.parseTimestamp(apiData.actual_in);
        if (status === FlightStatus.NotInitiated) {
          if (scheduledIn === 0n) {
            console.log(`[settle-sweep] ${flight.flight_id}: landed but no scheduled_in — cannot classify; will retry.`);
            actions.push({ flight: flight.flight_id, skipped: "Landed without scheduled_in" });
            continue;
          }
          await client.invokeContract(
            oracleId,
            "set_estimated_arrival",
            [
              client.addressToScVal(oraclePublicKey),
              client.symbolToScVal(flight.flight_id),
              client.u64ToScVal(flight.date),
              client.u64ToScVal(scheduledIn),
            ],
            config.oracleSecretKey
          );
          actions.push({ flight: flight.flight_id, transition: "NotInitiated → Active (schedule written)" });
        }

        console.log(`[settle-sweep] ${flight.flight_id}: Landed at ${actualArrival} (status: "${apiData.status}")`);
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
        actions.push({ flight: flight.flight_id, transition: "Active → Landed" });
        const delayMin = scheduledIn > 0n ? Math.round(Number(actualArrival - scheduledIn) / 60) : null;
        await logFlightOutcome({
          flightId: flight.flight_id,
          dateUnix: flight.date,
          outcome: delayMin !== null && delayMin >= 180 ? "delayed" : "ontime",
          delayMinutes: delayMin,
        });
        await classifyAndSettleFlight(client, config, flight.flight_id, flight.date, flight.flight_id, actions);
      } catch (err) {
        console.error(`[settle-sweep] ${flight.flight_id}: Error — ${err}. Will retry next cycle.`);
        actions.push({ flight: flight.flight_id, error: String(err) });
      }
    }

    console.log("[settle-sweep] Done.");
    return {
      timestamp: new Date().toISOString(),
      job: "fetcher",
      duration_ms: Date.now() - start,
      success: true,
      active_flights: activeFlightCount,
      actions,
    };
  } catch (err) {
    console.error(`[settle-sweep] Fatal error: ${err}`);
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
