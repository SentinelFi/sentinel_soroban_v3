import { USDC_BASE_UNITS } from "./routes_config";

/**
 * Client for the Python premium-pricing agent (agent/ — FastAPI + XGBoost,
 * hosted on Render; too heavy for a Vercel function).
 *
 * Failure semantic: any error → null. The route agent then falls back to
 * the routes-file terms, so a down/unset pricing service degrades to
 * human-set premiums, never to a broken cron. Same posture as the AeroAPI
 * and weather clients.
 */

export interface AgentPriceRequest {
  flight_id: string;
  carrier: string;
  origin: string;
  dest: string;
  payoff_usdc: number;
  month: number;
  day_of_month: number;
  day_of_week: number; // Mon=1 … Sun=7
  // Required by the deployed Render model build ("phase 22") — omitting
  // them 422s and the caller falls back. Sent when the DB route row has
  // the data (gov_onboard/admin fill sched_dep_local + distance_mi).
  dep_time_hhmm?: string;
  distance_mi?: number;
}

export interface AgentPriceResponse {
  p_delay: number;
  premium_usdc: number;
  premium_base_units: number;
  model_version: string;
}

const TIMEOUT_MS = 15_000;

export class AgentClient {
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /** Baseline premium in base units (7 decimals), or null on any failure. */
  async price(req: AgentPriceRequest): Promise<{ premiumBaseUnits: bigint; pDelay: number } | null> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    try {
      const resp = await fetch(`${this.baseUrl}/price`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`[agent] HTTP ${resp.status} pricing ${req.flight_id}`);
        return null;
      }
      const data = (await resp.json()) as AgentPriceResponse;
      if (typeof data.premium_usdc !== "number" || !Number.isFinite(data.premium_usdc)) {
        console.warn(`[agent] Malformed response for ${req.flight_id}`);
        return null;
      }
      // Recompute base units locally from the USDC figure — the service's
      // base-unit field is convenience, not trusted arithmetic.
      const premiumBaseUnits =
        (BigInt(Math.round(data.premium_usdc * 100)) * USDC_BASE_UNITS) / 100n;
      return { premiumBaseUnits, pDelay: data.p_delay };
    } catch (err) {
      console.warn(`[agent] Pricing call failed for ${req.flight_id}: ${err}`);
      return null;
    }
  }
}
