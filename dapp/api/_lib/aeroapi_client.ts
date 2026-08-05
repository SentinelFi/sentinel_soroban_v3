import type { Config } from "./types.js";

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
// A per-minute rate limit clears within its window; a monthly quota cap
// does not. 65s sits just past the window, so one cooldown-retry cleanly
// separates the two 429 kinds (their response BODIES are identical).
const RATE_LIMIT_COOLDOWN_MS = 65_000;
// Every request gets a hard timeout — a hanging response must never hang a
// job (found the hard way: schedule_check stalled a full cron slot).
const FETCH_TIMEOUT_MS = 45_000;
// /schedules max_pages above ~5 has been observed returning quota errors
// aggressively on lower tiers; stay conservative and cursor-paginate.
const MAX_PAGES_CLAMP = 5;

export class AeroApiClient {
  private baseUrl: string;
  private apiKey: string;
  /**
   * Run-level quota breaker: once the API answers "quota limit reached"
   * (429 with a quota detail — a PERMANENT condition until the billing
   * period resets, unlike a transient rate spike), every further request
   * in this process short-circuits to null instead of burning retry
   * cycles. Callers already fail safe on null.
   */
  private quotaExhausted = false;
  /**
   * OCA-M04: absolute wall-clock deadline (epoch ms). Serverless jobs run
   * under a hard maxDuration kill; a single flight's 429 cooldowns
   * (~65s × 3) must never sleep the function into that kill mid-loop.
   * When a retry sleep would cross the deadline the call gives up (null —
   * every caller fails safe) WITHOUT tripping the quota breaker.
   */
  private deadlineMs: number | null = null;

  constructor(config: Pick<Config, "aeroApiBaseUrl" | "aeroApiKey">) {
    this.baseUrl = config.aeroApiBaseUrl;
    this.apiKey = config.aeroApiKey;
  }

  setDeadline(epochMs: number): void {
    this.deadlineMs = epochMs;
  }

  // OCA-L06: the client validates and encodes its own inputs instead of
  // trusting every caller's discipline — several internal callers (route
  // guard, admin routes) reach here with values that were never
  // regex-checked upstream. Invalid input → null, same fail-soft contract
  // as every other client error.
  private static IDENT_RE = /^[A-Z0-9]{2,10}$/i;
  private static DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  private badInput(kind: string, value: unknown): null {
    console.warn(`[aeroapi] invalid ${kind} ${JSON.stringify(value)} — refusing to build request`);
    return null;
  }

  private wouldCrossDeadline(pendingSleepMs: number): boolean {
    return this.deadlineMs !== null && Date.now() + pendingSleepMs > this.deadlineMs;
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
  /**
   * Could a /flights query actually SEE the whole of `dateStr`?
   *
   * AeroAPI caps the window at 2 days in the future, so for a date near
   * that edge we can only inspect part of the day — and a flight departing
   * outside the visible slice comes back as an empty list, which is
   * indistinguishable from "no such flight". Callers use this to tell
   * "proven absent" from "could not look", and fall back to the published
   * schedule rather than refusing a real flight.
   */
  dayFullyVisible(dateStr: string): boolean {
    return Date.parse(`${dateStr}T23:59:59Z`) <= Date.now() + 2 * 24 * 3600_000;
  }

  async getFlightData(ident: string, dateStr: string): Promise<AeroApiFlight | null> {
    if (!AeroApiClient.IDENT_RE.test(ident)) return this.badInput("ident", ident);
    if (!AeroApiClient.DATE_RE.test(dateStr)) return this.badInput("date", dateStr);
    // AeroAPI constrains BOTH bounds to "no further than 2 days in the
    // future", and answers an out-of-range window with an EMPTY LIST rather
    // than an error — indistinguishable from "no such flight". Clamp `end`
    // DOWNWARD only, so the normal same-day window is untouched and only a
    // window that would fall outside the supported range is trimmed.
    const MAX_FUTURE_MS = 2 * 24 * 3600_000;
    const dayEnd = Date.parse(`${dateStr}T23:59:59Z`);
    const ceiling = Date.now() + MAX_FUTURE_MS;
    const endIso =
      dayEnd <= ceiling
        ? `${dateStr}T23:59:59Z`
        : new Date(ceiling).toISOString().replace(/\.\d{3}Z$/, "Z");
    const url =
      `${this.baseUrl}/flights/${encodeURIComponent(ident)}` +
      `?start=${encodeURIComponent(`${dateStr}T00:00:00Z`)}&end=${encodeURIComponent(endIso)}`;
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
    return data.flights[0] ?? null;
  }

  /**
   * Fetch EVERY tracked instance of an ident inside a date range (start
   * inclusive, end inclusive — pass full ISO timestamps). The range must
   * respect the same −10d..+2d visibility window as getFlightData.
   *
   * Unlike getFlightData this does NOT collapse to a single flight: the
   * route guard's cancellation sweep wants one entry per day the flight
   * operated (a flight number flying daily returns ~one instance per day).
   * Returns null on any error; an empty array means "verified: no tracked
   * instances in the range".
   */
  async getFlightInstances(
    ident: string,
    startIso: string,
    endIso: string
  ): Promise<AeroApiFlight[] | null> {
    if (!AeroApiClient.IDENT_RE.test(ident)) return this.badInput("ident", ident);
    if (Number.isNaN(Date.parse(startIso))) return this.badInput("startIso", startIso);
    if (Number.isNaN(Date.parse(endIso))) return this.badInput("endIso", endIso);
    const url =
      `${this.baseUrl}/flights/${encodeURIComponent(ident)}` +
      `?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
    const data = await this.requestJson<AeroApiResponse>(url, `${ident} ${startIso}..${endIso}`);
    if (!data) return null;
    return data.flights ?? [];
  }

  /**
   * Fetch published airline schedules for a date window (both bounds are
   * date strings; date_end is exclusive per the API).
   *
   * This is the far-horizon complement to getFlightData: /schedules serves
   * published schedules up to ONE YEAR into the future (vs /flights' 2-day
   * visibility), in windows of at most 3 weeks per request, filterable by
   * airline + flight_number (+ origin/destination). One call attests up to
   * 21 days of a flight's schedule — sale auth uses it to verify
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
      airline?: string;
      flightNumber?: string;
      origin?: string;
      destination?: string;
      /**
       * Server-side page aggregation. AeroAPI pages /schedules at ~15 rows;
       * without this a 20-day single-flight window (or any busy city pair)
       * silently truncates. Default 3 covers a full authorizer chunk; route
       * discovery passes more.
       */
      maxPages?: number;
    }
  ): Promise<AeroApiSchedulesResponse | null> {
    if (!AeroApiClient.DATE_RE.test(dateStartStr)) return this.badInput("dateStart", dateStartStr);
    if (!AeroApiClient.DATE_RE.test(dateEndStr)) return this.badInput("dateEnd", dateEndStr);
    // max_pages is clamped: values above ~5 have been observed answering
    // with quota errors / empty sets on lower tiers. Busy windows beyond
    // the first response are collected by FOLLOWING links.next cursors,
    // bounded to a few round-trips.
    const perRequestPages = Math.min(filters.maxPages ?? MAX_PAGES_CLAMP, MAX_PAGES_CLAMP);
    const params = new URLSearchParams({
      // One row per physical instance — marketing codeshares of the same
      // leg would otherwise show up as extra rows and trip ambiguity checks.
      include_codeshares: "false",
      include_regional: "false",
      max_pages: String(perRequestPages),
    });
    if (filters.airline) params.set("airline", filters.airline);
    if (filters.flightNumber) params.set("flight_number", filters.flightNumber);
    if (filters.origin) params.set("origin", filters.origin);
    if (filters.destination) params.set("destination", filters.destination);

    const label =
      `schedules ${filters.airline ?? ""}${filters.flightNumber ?? ""} ` +
      `${filters.origin ?? "*"}->${filters.destination ?? "*"} ${dateStartStr}..${dateEndStr}`;

    const MAX_CURSOR_FOLLOWS = 4;
    let url = `${this.baseUrl}/schedules/${dateStartStr}/${dateEndStr}?${params}`;
    let merged: AeroApiSchedulesResponse | null = null;
    for (let hop = 0; hop <= MAX_CURSOR_FOLLOWS; hop++) {
      const page = await this.requestJson<AeroApiSchedulesResponse>(url, `${label} [p${hop}]`);
      if (!page) {
        // First page failing = whole call failed (callers fail safe on
        // null). A LATER page failing returns what we have — partial data
        // under-counts, and every consumer treats missing days as
        // unverifiable/absent-fail-closed rather than harmful.
        return merged;
      }
      if (!merged) {
        merged = page;
      } else {
        merged.scheduled = [...(merged.scheduled ?? []), ...(page.scheduled ?? [])];
        merged.links = page.links;
      }
      const next = page.links?.next;
      if (!next) return merged;
      url = `${this.baseUrl}${next.startsWith("/") ? next.replace(/^\/aeroapi/, "") : `/${next}`}`;
    }
    console.warn(`[aeroapi] ${label}: cursor limit reached (${MAX_CURSOR_FOLLOWS} follows) — returning partial set.`);
    return merged;
  }

  /**
   * Shared GET-with-retry. Returns parsed JSON or null — never throws.
   * Retries 429/5xx and network errors with exponential backoff; 4xx are
   * permanent (logged, null).
   */
  private async requestJson<T>(url: string, label: string): Promise<T | null> {
    if (this.quotaExhausted) {
      return null; // breaker tripped — no point burning more calls this run
    }
    if (this.wouldCrossDeadline(0)) {
      console.warn(`[aeroapi] run deadline reached — skipping ${label}.`);
      return null;
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-apikey"] = this.apiKey;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

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

        // 429 — WORDING CANNOT DISTINGUISH the two kinds: AeroAPI's
        // per-minute rate limiter answers `{"reason":"RATE_LIMIT_ERROR",
        // "detail":"User has reached quota limit"}` — the same "quota"
        // wording as true billing-period exhaustion (observed live
        // 2026-07-29: a burst tripped the old /quota/i breaker mid-sweep
        // and silently killed 33 healthy calls). TIME distinguishes them:
        // a rate limit clears within its one-minute window, a monthly cap
        // does not. Cool down past the window and retry; only a 429 that
        // SURVIVES the cooldown trips the permanent run-level breaker.
        if (resp.status === 429) {
          if (this.wouldCrossDeadline(RATE_LIMIT_COOLDOWN_MS)) {
            console.warn(
              `[aeroapi] 429 for ${label} but a cooldown would cross the run deadline — ` +
                `giving up on this call (quota breaker NOT tripped).`
            );
            return null;
          }
          if (attempt < MAX_RETRIES) {
            console.warn(
              `[aeroapi] HTTP 429 for ${label} — rate-limit/quota ambiguous; ` +
                `cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
            );
            await sleep(RATE_LIMIT_COOLDOWN_MS);
            continue;
          }
          console.error(
            `[aeroapi] 429 persists after ${MAX_RETRIES} cooldown retries (${label}) — ` +
              `billing-period quota exhausted; halting API calls for this run.`
          );
          this.quotaExhausted = true;
          return null;
        }

        // Retryable errors — 5xx
        if (resp.status >= 500) {
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            if (this.wouldCrossDeadline(delay)) {
              console.warn(`[aeroapi] HTTP ${resp.status} for ${label} — retry would cross the run deadline, giving up.`);
              return null;
            }
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
          if (this.wouldCrossDeadline(delay)) {
            console.warn(`[aeroapi] Network error for ${label}: ${err} — retry would cross the run deadline, giving up.`);
            return null;
          }
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
