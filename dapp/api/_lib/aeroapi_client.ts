import type { Config } from "./types";

export interface AeroApiFlight {
  ident: string;
  cancelled: boolean;
  // Spec: "Flag indicating whether this flight was diverted." A diverted
  // flight's actual_in reflects arrival at the DIVERSION airport, not the
  // filed destination — never attest a normal landing from a diverted leg.
  diverted?: boolean;
  status: string;
  scheduled_out?: string | null;
  scheduled_in: string | null;
  estimated_in?: string | null;
  actual_off?: string | null;
  actual_on?: string | null;
  actual_in: string | null;
  arrival_delay: number | null;
}

export interface AeroApiResponse {
  flights: AeroApiFlight[];
}

/** One row of GET /schedules/{date_start}/{date_end} — published-schedule data. */
export interface AeroApiScheduledFlight {
  ident: string;
  ident_icao?: string | null;
  ident_iata?: string | null;
  actual_ident?: string | null;
  scheduled_out: string;
  scheduled_in: string;
  origin: string;
  destination: string;
  fa_flight_id?: string | null;
}

export interface AeroApiSchedulesResponse {
  scheduled: AeroApiScheduledFlight[];
  links?: { next: string } | null;
  num_pages?: number;
}

/** One row of GET /airports/delays — an airport-wide delay condition. */
export interface AeroApiAirportDelay {
  /** Airport code (ICAO for US airports, e.g. "KJFK"). */
  airport: string;
  /** Category of the largest delay: "weather", "traffic", ... */
  category: string;
  /** Severity color of the largest delay (red/yellow). */
  color: string;
  /** Duration of the largest delay in seconds (trend signal, not a promise). */
  delay_secs: number;
}

export interface AeroApiAirportDelaysResponse {
  delays: AeroApiAirportDelay[];
  links?: { next: string } | null;
  num_pages?: number;
}

/**
 * True only when AeroAPI's cancellation signal is corroborated.
 *
 * The spec is explicit that `cancelled` means "the flight is no longer being
 * tracked by FlightAware. There are a number of reasons this could happen
 * including cancellation by the airline, but that will not always be the
 * case." A tracking gap must NOT mint payouts: `set_cancelled` is forward-only
 * on-chain and settles every buyer at full payoff. We therefore require the
 * human-readable status to also say the flight is cancelled before writing
 * the tombstone. Revoking a sale window (close_sale) is safe on the bare
 * flag — fail closed — but the tombstone needs both signals.
 */
export function isConfirmedCancellation(flight: AeroApiFlight): boolean {
  return flight.cancelled && /cancel/i.test(flight.status ?? "");
}

/**
 * True when a diversion is corroborated. POLICY: a diverted flight pays as a
 * cancellation — the insured journey to the filed destination did not happen
 * as sold, and the on-chain Cancelled outcome already moves exactly the right
 * money (full payoff per buyer). Requires the `diverted` flag plus either a
 * diverted status text or a concluded leg (actual_on/actual_in at the
 * diversion airport) — a bare flag with no corroboration is retried, same as
 * cancellations.
 */
export function isConfirmedDiversion(flight: AeroApiFlight): boolean {
  return (
    Boolean(flight.diverted) &&
    !flight.cancelled &&
    (/divert/i.test(flight.status ?? "") ||
      Boolean(flight.actual_on) ||
      Boolean(flight.actual_in))
  );
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class AeroApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: Pick<Config, "aeroApiBaseUrl" | "aeroApiKey">) {
    this.baseUrl = config.aeroApiBaseUrl;
    this.apiKey = config.aeroApiKey;
  }

  /**
   * Fetch flight data for a given ident and date.
   *
   * IMPORTANT — visibility window: AeroAPI's /flights/{ident} accepts
   * start/end only within 10 days past to 2 days future (values outside
   * that range are a 400). Callers must gate their queries to that window;
   * this client will just surface the error as null.
   *
   * Returns the single matching flight, or null if there is no data OR if the
   * response is ambiguous. A policy is keyed on-chain by (flight_id, day), and a
   * flight number on a given calendar day should resolve to exactly one physical
   * flight. If AeroAPI returns more than one candidate for the day, the executor
   * must NOT guess (e.g. blindly take the last record): settling against the
   * wrong physical flight could pay or deny a claim incorrectly. Ambiguity is
   * logged and treated as "no usable data" so the flight stays unresolved and is
   * surfaced for operator attention rather than mis-settled.
   *
   * Retries on 429 (rate limit) and 5xx with exponential backoff.
   */
  async getFlightData(ident: string, dateStr: string): Promise<AeroApiFlight | null> {
    const url = `${this.baseUrl}/flights/${ident}?start=${dateStr}T00:00:00Z&end=${dateStr}T23:59:59Z`;
    const data = await this.requestJson<AeroApiResponse>(url, `${ident} on ${dateStr}`);
    if (!data) return null;

    if (!data.flights || data.flights.length === 0) {
      return null;
    }
    if (data.flights.length > 1) {
      console.warn(
        `[aeroapi] ${data.flights.length} candidate flights for ${ident} on ${dateStr} — ` +
          `ambiguous; refusing to guess which physical flight is insured. ` +
          `Skipping until disambiguated.`
      );
      return null;
    }
    return data.flights[0];
  }

  /**
   * Fetch published airline schedules for a date window (both bounds are
   * date strings; date_end is exclusive per the API).
   *
   * This is the far-horizon complement to getFlightData: /schedules serves
   * published schedules up to ONE YEAR into the future (vs /flights' 2-day
   * visibility), in windows of at most 3 weeks per request, filterable by
   * airline + flight_number (+ origin/destination). One call attests up to
   * 21 days of a flight's schedule — the sale authorizer uses it to verify
   * far-future days exist without burning a /flights call per day.
   *
   * Caveat (spec): schedule rows are "sourced from operator's schedule and
   * may not reflect actual flight information" — existence here attests
   * "published as scheduled", NOT "not cancelled". Near-departure
   * cancellation checks stay on getFlightData.
   *
   * Returns null on any error (same fail-soft semantics as getFlightData).
   */
  async getSchedules(
    dateStartStr: string,
    dateEndStr: string,
    filters: {
      airline: string;
      flightNumber: string;
      origin?: string;
      destination?: string;
    }
  ): Promise<AeroApiSchedulesResponse | null> {
    const params = new URLSearchParams({
      airline: filters.airline,
      flight_number: filters.flightNumber,
      // One row per physical instance — marketing codeshares of the same
      // leg would otherwise show up as extra rows and trip ambiguity checks.
      include_codeshares: "false",
      include_regional: "false",
    });
    if (filters.origin) params.set("origin", filters.origin);
    if (filters.destination) params.set("destination", filters.destination);

    const url = `${this.baseUrl}/schedules/${dateStartStr}/${dateEndStr}?${params}`;
    return this.requestJson<AeroApiSchedulesResponse>(
      url,
      `schedules ${filters.airline}${filters.flightNumber} ${dateStartStr}..${dateEndStr}`
    );
  }

  /**
   * Fetch the current airport-wide delay list — ONE call covers every
   * airport with an active delay condition, which makes it a nearly-free
   * network-wide governance signal source (the gov_signals collector maps
   * these onto the reconciler's signals table).
   *
   * Returns null on any error (fail-soft, like every other method).
   */
  async getAirportDelays(): Promise<AeroApiAirportDelaysResponse | null> {
    const url = `${this.baseUrl}/airports/delays`;
    return this.requestJson<AeroApiAirportDelaysResponse>(url, "airports/delays");
  }

  /**
   * Shared GET-with-retry. Returns parsed JSON or null — never throws.
   * Retries 429/5xx and network errors with exponential backoff; 4xx are
   * permanent (logged, null).
   */
  private async requestJson<T>(url: string, label: string): Promise<T | null> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-apikey"] = this.apiKey;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { headers });

        if (resp.ok) {
          // Node's fetch types resp.json() as unknown — the executor's DOM
          // lib typed it any. Same trust boundary either way.
          return (await resp.json()) as T;
        }

        // Permanent errors — don't retry
        if (resp.status === 401 || resp.status === 403) {
          console.error(`[aeroapi] HTTP ${resp.status} for ${label} — bad API key or forbidden`);
          return null;
        }
        if (resp.status === 404) {
          console.warn(`[aeroapi] HTTP 404 for ${label} — not found`);
          return null;
        }

        // Retryable errors — 429 and 5xx
        if (resp.status === 429 || resp.status >= 500) {
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[aeroapi] HTTP ${resp.status} for ${label}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
            await sleep(delay);
            continue;
          }
          console.error(`[aeroapi] HTTP ${resp.status} for ${label} after ${MAX_RETRIES} retries, giving up`);
          return null;
        }

        // Other errors (incl. 400 out-of-visibility-range) — don't retry
        console.warn(`[aeroapi] HTTP ${resp.status} for ${label}`);
        return null;
      } catch (err) {
        // Network errors — retry
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[aeroapi] Network error for ${label}: ${err}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          await sleep(delay);
          continue;
        }
        console.error(`[aeroapi] Network error for ${label} after ${MAX_RETRIES} retries: ${err}`);
        return null;
      }
    }

    return null;
  }

  /** Parse an ISO timestamp to unix seconds. */
  parseTimestamp(iso: string | null): bigint {
    if (!iso) return 0n;
    return BigInt(Math.floor(new Date(iso).getTime() / 1000));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
