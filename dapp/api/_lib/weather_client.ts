import { AIRPORTS } from "./airports";

/**
 * Open-Meteo forecast client for the route agent's weather check.
 *
 * Keyless and free — fits Vercel with no secret. Failure semantic: any
 * error or unknown airport → null, which the decision module treats as
 * "no weather signal" (noop). The weather agent must never disable a
 * route because a forecast API hiccuped; real insurability is still
 * gated by the sale authorizer (AeroAPI, fail-closed).
 */

export interface DailyForecast {
  /** Max wind gusts over the horizon, km/h. */
  maxWindGustKmh: number;
  /** Total snowfall over the horizon, cm. */
  totalSnowfallCm: number;
  /** Max daily precipitation probability over the horizon, %. */
  maxPrecipProbPct: number;
  /** WMO weather codes observed over the horizon. */
  weatherCodes: number[];
}

export class WeatherClient {
  private baseUrl: string;
  private forecastDays: number;

  constructor(baseUrl: string, forecastDays: number) {
    this.baseUrl = baseUrl;
    this.forecastDays = forecastDays;
  }

  /** Forecast for an IATA airport code, or null (unknown airport / API failure). */
  async getForecast(iata: string): Promise<DailyForecast | null> {
    const coords = AIRPORTS[iata];
    if (!coords) {
      console.warn(`[weather] Unknown airport ${iata} — skipping weather check.`);
      return null;
    }

    const days = Math.min(Math.max(this.forecastDays, 1), 16); // API cap
    const url =
      `${this.baseUrl}?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&daily=weather_code,wind_gusts_10m_max,snowfall_sum,precipitation_probability_max` +
      `&forecast_days=${days}&timezone=UTC`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[weather] HTTP ${resp.status} for ${iata}`);
        return null;
      }
      const data = (await resp.json()) as {
        daily?: {
          weather_code?: number[];
          wind_gusts_10m_max?: (number | null)[];
          snowfall_sum?: (number | null)[];
          precipitation_probability_max?: (number | null)[];
        };
      };
      const d = data.daily;
      if (!d) return null;

      const nums = (xs: (number | null)[] | undefined) =>
        (xs ?? []).filter((v): v is number => typeof v === "number");

      return {
        maxWindGustKmh: Math.max(0, ...nums(d.wind_gusts_10m_max)),
        totalSnowfallCm: nums(d.snowfall_sum).reduce((s, v) => s + v, 0),
        maxPrecipProbPct: Math.max(0, ...nums(d.precipitation_probability_max)),
        weatherCodes: d.weather_code ?? [],
      };
    } catch (err) {
      console.warn(`[weather] Fetch failed for ${iata}: ${err}`);
      return null;
    }
  }
}
