import type { DailyForecast } from "./weather_client";
import type { OnChainRoute } from "./governance";
import type { RouteEntry, RouteRails } from "./routes_config";

/**
 * PURE decision module for the daily route agent (no I/O — mirrors the
 * Solana Phase 23 `decide_route_actions` pattern so every branch is
 * unit-testable without a chain, a model, or a forecast API).
 *
 * Inputs per route:
 *  - the human intent from config/routes.testnet.json (`enabled`)
 *  - the current on-chain RouteStatus (Active / Disabled / Unknown)
 *  - the ML baseline premium (or the file terms when the agent is down)
 *  - the weather severity for origin + destination
 *  - the rails (hard min/max premium, max daily step, weather multiplier)
 *
 * Action set (closed):
 *   noop                — nothing to change / missing data / human said no
 *   update_premium      — reprice within rails + daily step cap
 *   disable             — severe weather OR file says enabled:false
 *   reenable_with_terms — file says enabled:true, weather cleared, route
 *                          currently disabled on-chain
 *
 * The re-enable rule is deliberately governed by the FILE, not by memory
 * of who disabled what: `enabled:false` in the file is permanent human
 * intent that the agent never overrides, and a human who wants a route
 * back simply leaves/sets `enabled:true`. This keeps the agent stateless
 * (nothing to persist between serverless invocations).
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

export type RouteAction =
  | { kind: "noop"; reason: string }
  | { kind: "update_premium"; newPremium: bigint; reason: string }
  | { kind: "disable"; reason: string }
  | { kind: "reenable_with_terms"; newPremium: bigint; reason: string };

export function decideRouteAction(
  fileRoute: Pick<RouteEntry, "enabled">,
  onChain: OnChainRoute,
  baselinePremium: bigint,
  severity: WeatherSeverity,
  rails: RouteRails
): RouteAction {
  // ── Branch 1: human said no — enforce, never re-enable ─────────────
  if (!fileRoute.enabled) {
    if (onChain.status === "Active") {
      return { kind: "disable", reason: "routes file: enabled=false" };
    }
    return { kind: "noop", reason: "routes file: enabled=false (already off-chain-disabled or unknown)" };
  }

  // ── Branch 2: severe weather — close the route ─────────────────────
  if (severity === "severe") {
    if (onChain.status === "Active") {
      return { kind: "disable", reason: "severe weather at origin/destination" };
    }
    return { kind: "noop", reason: "severe weather; route already not active" };
  }

  // ── Branch 3: not yet whitelisted — the script's job, not the agent's ─
  if (onChain.status === "Unknown") {
    return { kind: "noop", reason: "route not whitelisted on-chain (run whitelist script)" };
  }

  const target = clampPremium(
    severity === "elevated"
      ? applyMultiplier(baselinePremium, rails.elevatedWeatherMultiplier)
      : baselinePremium,
    onChain.terms?.premium ?? null,
    rails
  );

  // ── Branch 4: disabled on-chain, human wants it on, weather clear ──
  if (onChain.status === "Disabled") {
    return {
      kind: "reenable_with_terms",
      newPremium: target,
      reason: `weather ${severity === "elevated" ? "elevated (repriced)" : "clear"}; routes file enabled=true`,
    };
  }

  // ── Branch 5: active — reprice if drift exceeds the threshold ──────
  const current = onChain.terms?.premium ?? null;
  if (current !== null) {
    const drift = target > current ? target - current : current - target;
    if (drift < DRIFT_THRESHOLD_BASE_UNITS) {
      return { kind: "noop", reason: "within drift threshold" };
    }
  }
  return {
    kind: "update_premium",
    newPremium: target,
    reason: severity === "elevated" ? "elevated weather multiplier" : "ML baseline reprice",
  };
}
