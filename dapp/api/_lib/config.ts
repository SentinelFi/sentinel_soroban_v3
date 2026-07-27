import type { Config } from "./types";

/**
 * Env-driven config for the serverless cron functions.
 *
 * Env var names inherited from the legacy centralized_cron executor, so
 * an old .env still works without renaming. Non-secret values default
 * to the Phase 3 testnet deployment (deployments/testnet.json);
 * secrets are always required and never defaulted.
 *
 * These are SERVER-SIDE vars (Vercel project env) — no PUBLIC_ prefix,
 * never bundled into the browser build.
 */

// Defaults mirror the 2026-07-18 testnet deployment — the same IDs the
// frontend hardcodes in dapp/src/contracts/*.ts. (The previous defaults
// pointed at the retired 07-11 deployment, whose oracle predates
// open_sale/close_sale — the sale authorizer cannot run against it.)
const TESTNET_DEFAULTS: Record<string, string> = {
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ORACLE_AGGREGATOR_ID: "CBSX3KRT4JI7XAOB33OTGZMZVOFXOS2LWDQCQKR2UAGHRMWYMC2D6QUL",
  CONTROLLER_ID: "CCWDQVAJCNMU2P35JF5RNGC7PM2LGWBXBSO6QUME2PJFK5LTVFNQZGHB",
  RISK_VAULT_ID: "CAHUWF7GMAKZK34C3BBQWHA4GLAI2OSXGL25KMLW45INBDJMVQRAL3QW",
  GOVERNANCE_ID: "CANSHOFUFZPLZPCVUQYL3LBO25FW5BP6AEVAMNN2QS2BINGDIVZVEWYZ",
  FLIGHT_POOL_MANAGER_ID: "CD6XRCMKALQLB63ZYMA7GCW3Q2BQROGKYASRRRNZEFRPINQ6JFXO6YZT",
  // Real AeroAPI (the executor defaulted to its local mock; that makes no
  // sense in a serverless deployment). Override for mock-api testing.
  AEROAPI_BASE_URL: "https://aeroapi.flightaware.com/aeroapi",
};

function envOrDefault(name: string): string {
  return process.env[name] ?? TESTNET_DEFAULTS[name];
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export function loadConfig(): Config {
  return {
    stellarRpcUrl: envOrDefault("STELLAR_RPC_URL"),
    networkPassphrase: envOrDefault("STELLAR_NETWORK_PASSPHRASE"),
    oracleAggregatorId: envOrDefault("ORACLE_AGGREGATOR_ID"),
    controllerId: envOrDefault("CONTROLLER_ID"),
    riskVaultId: envOrDefault("RISK_VAULT_ID"),
    governanceId: envOrDefault("GOVERNANCE_ID"),
    // Phase 3 — replaces RECOVERY_POOL_ID; recovery accounting is now
    // folded into FlightPoolManager.
    flightPoolManagerId: envOrDefault("FLIGHT_POOL_MANAGER_ID"),
    oracleSecretKey: requireEnv("ORACLE_SECRET_KEY"),
    keeperSecretKey: requireEnv("KEEPER_SECRET_KEY"),
    ttlExtenderSecretKey: requireEnv("TTL_EXTENDER_SECRET_KEY"),
    // Optional 4th identity: GovernanceModule admin for the route agent
    // and the whitelist script. Never the owner key.
    governanceAdminSecretKey: process.env.GOVERNANCE_ADMIN_SECRET_KEY || undefined,
    aeroApiBaseUrl: envOrDefault("AEROAPI_BASE_URL"),
    aeroApiKey: process.env.AEROAPI_KEY ?? "",
    // Fetcher polling window before the recorded scheduled arrival
    // (cancellation watch + landing resolution). Default 6h.
    fetcherWatchSecs: parsePositiveInt(process.env.FETCHER_WATCH_SECS, 21_600),
    // Sale authorization. 0/unset horizon falls back to the routes file's
    // sale_horizon_days at job start.
    saleAuthHorizonDays: parsePositiveInt(process.env.SALE_AUTH_HORIZON_DAYS, 0),
    saleAuthValiditySecs: Math.min(
      parsePositiveInt(process.env.SALE_AUTH_VALIDITY_SECS, 21_600), // 6h
      86_400 // on-chain cap — larger values would revert every open_sale
    ),
    agentBaseUrl: process.env.AGENT_BASE_URL || undefined,
    agentToken: process.env.AGENT_TOKEN || undefined,
    weatherBaseUrl: process.env.WEATHER_BASE_URL ?? "https://api.open-meteo.com/v1/forecast",
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Non-secret view for the health endpoint. Never throws on missing
 * secrets — it reports their presence as booleans only.
 */
export function loadPublicConfig(): {
  network: string;
  rpcUrl: string;
  contractIds: Record<string, string>;
  hasKeys: { oracle: boolean; keeper: boolean; ttl: boolean };
} {
  return {
    network: envOrDefault("STELLAR_NETWORK_PASSPHRASE"),
    rpcUrl: envOrDefault("STELLAR_RPC_URL"),
    contractIds: {
      oracleAggregator: envOrDefault("ORACLE_AGGREGATOR_ID"),
      controller: envOrDefault("CONTROLLER_ID"),
      riskVault: envOrDefault("RISK_VAULT_ID"),
      governance: envOrDefault("GOVERNANCE_ID"),
      flightPoolManager: envOrDefault("FLIGHT_POOL_MANAGER_ID"),
    },
    hasKeys: {
      oracle: Boolean(process.env.ORACLE_SECRET_KEY),
      keeper: Boolean(process.env.KEEPER_SECRET_KEY),
      ttl: Boolean(process.env.TTL_EXTENDER_SECRET_KEY),
    },
  };
}
