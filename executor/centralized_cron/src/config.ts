import "dotenv/config";
import type { Config } from "./types.js";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export function loadConfig(): Config {
  return {
    stellarRpcUrl: requireEnv("STELLAR_RPC_URL"),
    networkPassphrase: requireEnv("STELLAR_NETWORK_PASSPHRASE"),
    oracleAggregatorId: requireEnv("ORACLE_AGGREGATOR_ID"),
    controllerId: requireEnv("CONTROLLER_ID"),
    riskVaultId: requireEnv("RISK_VAULT_ID"),
    governanceId: requireEnv("GOVERNANCE_ID"),
    // Phase 3 — replaces RECOVERY_POOL_ID; recovery accounting is now
    // folded into FlightPoolManager.
    flightPoolManagerId: requireEnv("FLIGHT_POOL_MANAGER_ID"),
    oracleSecretKey: requireEnv("ORACLE_SECRET_KEY"),
    keeperSecretKey: requireEnv("KEEPER_SECRET_KEY"),
    ttlExtenderSecretKey: requireEnv("TTL_EXTENDER_SECRET_KEY"),
    aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "http://localhost:3001",
    aeroApiKey: process.env.AEROAPI_KEY ?? "",
    // Sale authorization. Empty list means NO sale windows are ever opened
    // and every purchase fails closed — deliberate fail-safe default; set it
    // to the flight numbers of the governance-whitelisted routes.
    saleAuthFlightIds: (process.env.SALE_AUTH_FLIGHT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    saleAuthHorizonDays: parsePositiveInt(
      process.env.SALE_AUTH_HORIZON_DAYS,
      90 // matches the controller's maximum booking horizon
    ),
    saleAuthValiditySecs: Math.min(
      parsePositiveInt(process.env.SALE_AUTH_VALIDITY_SECS, 21_600), // 6h
      86_400 // on-chain cap — larger values would revert every open_sale
    ),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
