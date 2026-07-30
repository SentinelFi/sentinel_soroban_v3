import { readFileSync } from "fs";
import rawConfig from "../../config/routes.testnet.json";

/**
 * Typed loader for config/routes.testnet.json — the single human source of
 * truth for insurable routes. See the $schema_note inside the JSON.
 *
 * Amounts in the file are human USDC; everything on-chain uses 7-decimal
 * base units (Stellar SAC convention, matches mock_usdc.decimals() == 7).
 */

export const USDC_BASE_UNITS = 10_000_000n; // 7 decimals

export interface RouteTermsOverride {
  premium_usdc?: number | null;
  payoff_usdc?: number | null;
  delay_hours?: number | null;
}

export interface RouteEntry {
  flight_id: string;
  carrier: string;
  origin: string;
  destination: string;
  enabled: boolean;
  overrides: RouteTermsOverride | null;
  notes?: string;
}

export interface RouteRails {
  premiumMin: bigint; // base units — floor for any premium
  premiumMax: bigint; // base units — TOTAL on-chain ceiling (base + weather surcharge)
  /** ML base-premium cap, base units. Routes whose honest expected-loss
   *  price exceeds this are EXCLUDED from whitelisting, never clamped —
   *  the protocol does not sell at a known expected loss. */
  basePremiumMax: bigint;
  /** Flat additive weather surcharges, base units (whole dollars). */
  weatherSurcharge: { elevated: bigint; severe: bigint };
  payoffMin: bigint;
  payoffMax: bigint;
}

export interface RoutesConfig {
  network: string;
  defaults: { premiumUsdc: number; payoffUsdc: number; delayHours: number };
  rails: RouteRails;
  saleHorizonDays: number;
  /** Forecast look-ahead for the weather surcharge job (days). Kept short
   *  (~3): storm forecasts have no skill beyond that, and neither do
   *  buyers — which is exactly the adverse-selection window to price. */
  weatherHorizonDays: number;
  routes: RouteEntry[];
}

export function usdcToBaseUnits(usdc: number): bigint {
  // Round to avoid float dust; amounts in the file are dollars(.cents).
  return BigInt(Math.round(usdc * 100)) * (USDC_BASE_UNITS / 100n);
}

export function baseUnitsToUsdc(units: bigint): number {
  return Number(units) / Number(USDC_BASE_UNITS);
}

export function loadRoutesConfig(): RoutesConfig {
  // ROUTES_CONFIG_PATH lets tests (and future networks) point at a different
  // routes file; the static import stays the bundled default for Vercel.
  const overridePath = process.env.ROUTES_CONFIG_PATH;
  const raw = overridePath
    ? (JSON.parse(readFileSync(overridePath, "utf-8")) as typeof rawConfig)
    : rawConfig;
  const c = raw as {
    network: string;
    defaults: { premium_usdc: number; payoff_usdc: number; delay_hours: number };
    rails: {
      premium_usdc: { min: number; max: number };
      base_premium_max_usdc: number;
      weather_surcharge_usdc: { elevated: number; severe: number };
      payoff_usdc: { min: number; max: number };
    };
    sale_horizon_days: number;
    weather_horizon_days: number;
    routes: RouteEntry[];
  };

  return {
    network: c.network,
    defaults: {
      premiumUsdc: c.defaults.premium_usdc,
      payoffUsdc: c.defaults.payoff_usdc,
      delayHours: c.defaults.delay_hours,
    },
    rails: {
      premiumMin: usdcToBaseUnits(c.rails.premium_usdc.min),
      premiumMax: usdcToBaseUnits(c.rails.premium_usdc.max),
      basePremiumMax: usdcToBaseUnits(c.rails.base_premium_max_usdc),
      weatherSurcharge: {
        elevated: usdcToBaseUnits(c.rails.weather_surcharge_usdc.elevated),
        severe: usdcToBaseUnits(c.rails.weather_surcharge_usdc.severe),
      },
      payoffMin: usdcToBaseUnits(c.rails.payoff_usdc.min),
      payoffMax: usdcToBaseUnits(c.rails.payoff_usdc.max),
    },
    saleHorizonDays: c.sale_horizon_days,
    weatherHorizonDays: c.weather_horizon_days ?? 3,
    routes: c.routes,
  };
}

/** Effective (file-level) terms for a route: overrides folded with defaults. */
export function fileTerms(config: RoutesConfig, route: RouteEntry): {
  premium: bigint;
  payoff: bigint;
  delayHours: number;
} {
  return {
    premium: usdcToBaseUnits(route.overrides?.premium_usdc ?? config.defaults.premiumUsdc),
    payoff: usdcToBaseUnits(route.overrides?.payoff_usdc ?? config.defaults.payoffUsdc),
    delayHours: route.overrides?.delay_hours ?? config.defaults.delayHours,
  };
}

/** Unique flight ids of enabled routes — feeds the sale authorizer. */
export function enabledFlightIds(config: RoutesConfig): string[] {
  return [...new Set(config.routes.filter((r) => r.enabled).map((r) => r.flight_id))];
}
