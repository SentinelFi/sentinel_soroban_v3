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
  premiumMin: bigint; // base units
  premiumMax: bigint; // base units
  payoffMin: bigint;
  payoffMax: bigint;
  maxDailyPremiumChangePct: number;
  elevatedWeatherMultiplier: number;
}

export interface RoutesConfig {
  network: string;
  defaults: { premiumUsdc: number; payoffUsdc: number; delayHours: number };
  rails: RouteRails;
  saleHorizonDays: number;
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
  const c = rawConfig as {
    network: string;
    defaults: { premium_usdc: number; payoff_usdc: number; delay_hours: number };
    rails: {
      premium_usdc: { min: number; max: number };
      payoff_usdc: { min: number; max: number };
      max_daily_premium_change_pct: number;
      elevated_weather_multiplier: number;
    };
    sale_horizon_days: number;
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
      payoffMin: usdcToBaseUnits(c.rails.payoff_usdc.min),
      payoffMax: usdcToBaseUnits(c.rails.payoff_usdc.max),
      maxDailyPremiumChangePct: c.rails.max_daily_premium_change_pct,
      elevatedWeatherMultiplier: c.rails.elevated_weather_multiplier,
    },
    saleHorizonDays: c.sale_horizon_days,
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
