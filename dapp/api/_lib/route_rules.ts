import type { DailyForecast } from "./weather_client.js";
import type { RouteRails } from "./routes_config.js";

/**
 * PURE weather + premium math shared by the governance layer (no I/O):
 * forecast severity classification (the weather job's Open-Meteo verdicts,
 * re-used by the revive engine) and the premium rails/band arithmetic.
 * Decisions live with their detectors; the one door to acting on them is
 * pauseRoute/reviveRoute in governance/interventions.ts.
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

// EXTREME — a tier above "severe" (which only adds the +$10 surcharge):
// conditions under which flying plausibly stops altogether, so selling
// stops too. Hurricane-force gusts (≥120 km/h ≈ Beaufort 12) or a
// blizzard-scale dump. Extreme at either airport → the weather job opens
// a `weather` intervention (pause); the hourly revive cron lifts it the
// moment the forecast drops back below these numbers.
export const EXTREME_GUST_KMH = 120;
export const EXTREME_SNOW_CM = 40;

/** True when a forecast is EXTREME (pause-worthy). null → false (fail-open). */
export function isExtremeForecast(f: DailyForecast | null): boolean {
  if (!f) return false;
  return f.maxWindGustKmh >= EXTREME_GUST_KMH || f.totalSnowfallCm >= EXTREME_SNOW_CM;
}

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

// ── expected-loss pricing ──────────────────────────────────────────

/**
 * Loading factor on expected loss. Lives HERE, not in the ML service:
 * the prediction API (agent/) is deliberately insurance-blind — it
 * returns only the calibrated covered-event probability, and the
 * protocol turns probability into price.
 */
export const EXPECTED_LOSS_MARGIN = 1.3;

/**
 * premium = p_covered × payoff × margin, in 7-decimal base units.
 * Callers clamp the result to the rails via clampPremium — this is the
 * raw expected-loss figure only.
 */
export function expectedLossPremiumUnits(pCovered: number, payoffUnits: bigint): bigint {
  // Scale the float side to integer basis points to keep the arithmetic
  // exact in bigint space (p and margin both carry ≤4 meaningful digits).
  const pBps = BigInt(Math.round(pCovered * EXPECTED_LOSS_MARGIN * 10_000));
  return (payoffUnits * pBps) / 10_000n;
}

// ── premium bands (2026-07-30 redesign) ────────────────────────────
//
// Premiums are two independent, additive bands — one standard each:
//   BASE  $10–$20  ML expected-loss price, whole dollars, set at seeding
//                  and at the monthly repricing ritual. Above $20 the
//                  route is EXCLUDED (never sold at expected loss).
//   +WEATHER $2/$10 flat surcharge from the live 3-day forecast, applied
//                  and cleared by the stateless weather job.
// TOTAL is clamped to rails.premiumMax ($30). All values whole dollars.

const ONE_DOLLAR_UNITS = 10_000_000n; // 7-decimal USDC

/** Round premium UP to whole dollars — rounding error favors the vault. */
export function roundUpToWholeDollar(units: bigint): bigint {
  const rem = units % ONE_DOLLAR_UNITS;
  return rem === 0n ? units : units + (ONE_DOLLAR_UNITS - rem);
}

/**
 * ML BASE premium for a route: expected loss × margin, rounded UP to a
 * whole dollar, floored at rails.premiumMin. Returns null when the
 * honest price exceeds rails.basePremiumMax — the route is EXCLUDED
 * from whitelisting rather than sold at a known expected loss.
 */
export function mlBasePremiumUnits(
  pCovered: number,
  payoffUnits: bigint,
  rails: RouteRails
): bigint | null {
  const honest = expectedLossPremiumUnits(pCovered, payoffUnits);
  if (honest > rails.basePremiumMax) return null;
  let premium = roundUpToWholeDollar(honest);
  if (premium < rails.premiumMin) premium = rails.premiumMin;
  if (premium > rails.basePremiumMax) premium = rails.basePremiumMax;
  return premium;
}

/** Clamp a target premium to the min/max rails (total, incl. surcharge). */
export function clampPremium(target: bigint, rails: RouteRails): bigint {
  let result = target;
  if (result < rails.premiumMin) result = rails.premiumMin;
  if (result > rails.premiumMax) result = rails.premiumMax;
  return result;
}

/** Flat weather surcharge for a severity, base units (0 when ok). */
export function weatherSurchargeUnits(severity: WeatherSeverity, rails: RouteRails): bigint {
  if (severity === "severe") return rails.weatherSurcharge.severe;
  if (severity === "elevated") return rails.weatherSurcharge.elevated;
  return 0n;
}
