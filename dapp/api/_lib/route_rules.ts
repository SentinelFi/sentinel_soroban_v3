import type { DailyForecast } from "./weather_client";
import type { RouteRails } from "./routes_config";

/**
 * PURE weather + premium math shared by the governance layer (no I/O):
 * forecast severity classification (route_agent's Open-Meteo verdicts),
 * rails clamping and multiplier arithmetic (the reconciler's rules).
 * The old direct-action decider was removed when route_agent became a
 * facts-only collector — decideReconcileAction (governance/rules.ts) is
 * the single decision engine.
 */

// ── weather severity ───────────────────────────────────────────────

export type WeatherSeverity = "ok" | "elevated" | "severe";

// WMO codes: 95 thunderstorm, 96/99 thunderstorm with hail.
const SEVERE_WEATHER_CODES = new Set([96, 99]);
const ELEVATED_WEATHER_CODES = new Set([95]);

export const SEVERE_GUST_KMH = 90;
export const SEVERE_SNOW_CM = 20;
export const ELEVATED_GUST_KMH = 60;
export const ELEVATED_SNOW_CM = 5;
export const ELEVATED_PRECIP_PROB_PCT = 80;

/** Severity of a single airport forecast. null forecast → "ok" (fail-open). */
export function classifyForecast(f: DailyForecast | null): WeatherSeverity {
  if (!f) return "ok";
  if (
    f.maxWindGustKmh >= SEVERE_GUST_KMH ||
    f.totalSnowfallCm >= SEVERE_SNOW_CM ||
    f.weatherCodes.some((c) => SEVERE_WEATHER_CODES.has(c))
  ) {
    return "severe";
  }
  if (
    f.maxWindGustKmh >= ELEVATED_GUST_KMH ||
    f.totalSnowfallCm >= ELEVATED_SNOW_CM ||
    f.maxPrecipProbPct >= ELEVATED_PRECIP_PROB_PCT ||
    f.weatherCodes.some((c) => ELEVATED_WEATHER_CODES.has(c))
  ) {
    return "elevated";
  }
  return "ok";
}

/** Route severity = worst of origin and destination. */
export function combineSeverity(a: WeatherSeverity, b: WeatherSeverity): WeatherSeverity {
  if (a === "severe" || b === "severe") return "severe";
  if (a === "elevated" || b === "elevated") return "elevated";
  return "ok";
}

// ── premium clamping ───────────────────────────────────────────────

/**
 * Clamp a target premium to the rails, then cap the per-day step relative
 * to the current on-chain premium (max_daily_premium_change_pct) so a
 * model glitch can't reprice a route 10x overnight. Current === null
 * (route not yet priced on-chain) skips the step cap.
 */
export function clampPremium(
  target: bigint,
  current: bigint | null,
  rails: RouteRails
): bigint {
  let result = target;
  if (current !== null && current > 0n && rails.maxDailyPremiumChangePct > 0) {
    const pct = BigInt(rails.maxDailyPremiumChangePct);
    const maxUp = current + (current * pct) / 100n;
    const maxDown = current - (current * pct) / 100n;
    if (result > maxUp) result = maxUp;
    if (result < maxDown) result = maxDown;
  }
  if (result < rails.premiumMin) result = rails.premiumMin;
  if (result > rails.premiumMax) result = rails.premiumMax;
  return result;
}

/** Apply the elevated-weather multiplier (integer-safe, 2dp precision). */
export function applyMultiplier(premium: bigint, multiplier: number): bigint {
  const scaled = BigInt(Math.round(multiplier * 100));
  return (premium * scaled) / 100n;
}

// ── decision ───────────────────────────────────────────────────────

/** Skip premium writes smaller than this (1 USDC) — no churn txs. */
export const DRIFT_THRESHOLD_BASE_UNITS = 10_000_000n;

// (decideRouteAction/RouteAction removed 2026-07-27: route_agent no longer
// acts directly — it writes pricing/weather SIGNALS and the reconciler's
// decideReconcileAction is the single decision engine.)
