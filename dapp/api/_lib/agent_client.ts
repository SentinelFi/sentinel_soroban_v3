/**
 * Client for the Python prediction service (agent/ — FastAPI + XGBoost,
 * Render service "flight-delay-predictions"; too heavy for a Vercel
 * function).
 *
 * The service is a PURE PREDICTION API: route + date + time in, calibrated
 * covered-event probability out. It knows nothing about premiums — the
 * expected-loss pricing lives on THIS side (route_rules.ts
 * expectedLossPremiumUnits + clampPremium), applied by the route_agent
 * cron.
 *
 * Failure semantic: any error → null. The route agent then falls back to
 * the routes-file terms, so a down/unset prediction service degrades to
 * human-set premiums, never to a broken cron. Same posture as the AeroAPI
 * and weather clients.
 */

export interface AgentPredictRequest {
  carrier: string;
  origin: string;
  dest: string;
  month: number;
  day_of_month: number;
  day_of_week: number; // Mon=1 … Sun=7
  // Optional (service defaults: noon / 1000 mi). Sent when the DB route
  // row has the data (gov_onboard/admin fill sched_dep_local +
  // distance_mi) — departure time especially moves the prediction.
  dep_time_hhmm?: number;
  distance_mi?: number;
}

export interface AgentPredictResponse {
  p_covered: number;
  risk: string;
  baseline: number;
  vs_baseline: number;
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

  /** Calibrated covered-event probability for a route/date/time, or null. */
  async predict(req: AgentPredictRequest, label: string): Promise<number | null> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    try {
      const resp = await fetch(`${this.baseUrl}/predict`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`[agent] HTTP ${resp.status} predicting ${label}`);
        return null;
      }
      const data = (await resp.json()) as AgentPredictResponse;
      if (
        typeof data.p_covered !== "number" ||
        !Number.isFinite(data.p_covered) ||
        data.p_covered < 0 ||
        data.p_covered > 1
      ) {
        console.warn(`[agent] Malformed response for ${label}`);
        return null;
      }
      return data.p_covered;
    } catch (err) {
      console.warn(`[agent] Prediction call failed for ${label}: ${err}`);
      return null;
    }
  }
}
