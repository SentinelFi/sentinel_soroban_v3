import type { Config } from "./types.js";

export interface AeroApiFlight {
  ident: string;
  cancelled: boolean;
  status: string;
  scheduled_in: string | null;
  actual_in: string | null;
  arrival_delay: number | null;
}

export interface AeroApiResponse {
  flights: AeroApiFlight[];
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

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-apikey"] = this.apiKey;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { headers });

        if (resp.ok) {
          const data: AeroApiResponse = await resp.json();
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

        // Permanent errors — don't retry
        if (resp.status === 401 || resp.status === 403) {
          console.error(`[aeroapi] HTTP ${resp.status} for ${ident} — bad API key or forbidden`);
          return null;
        }
        if (resp.status === 404) {
          console.warn(`[aeroapi] HTTP 404 for ${ident} on ${dateStr} — flight not found`);
          return null;
        }

        // Retryable errors — 429 and 5xx
        if (resp.status === 429 || resp.status >= 500) {
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[aeroapi] HTTP ${resp.status} for ${ident}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
            await sleep(delay);
            continue;
          }
          console.error(`[aeroapi] HTTP ${resp.status} for ${ident} after ${MAX_RETRIES} retries, giving up`);
          return null;
        }

        // Other errors — don't retry
        console.warn(`[aeroapi] HTTP ${resp.status} for ${ident} on ${dateStr}`);
        return null;
      } catch (err) {
        // Network errors — retry
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[aeroapi] Network error for ${ident}: ${err}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          await sleep(delay);
          continue;
        }
        console.error(`[aeroapi] Network error for ${ident} after ${MAX_RETRIES} retries: ${err}`);
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
