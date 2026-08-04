import type { Config } from "./types.js";

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
const TESTNET_DEFAULTS = {
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ORACLE_AGGREGATOR_ID: "CDMKBMNJ2YZTARAM4ZUU7HZJZA7UUYJU76ZOAN2SCR3WJYZSSHXV7ESW",
  CONTROLLER_ID: "CBDJIPZOC7KH3ICK57MAUZMUXBQ5XF56WJLRP2OY6FF5V2HOFDOFXVY3",
  RISK_VAULT_ID: "CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF",
  GOVERNANCE_ID: "CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE",
  FLIGHT_POOL_MANAGER_ID: "CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7",
  // Real AeroAPI (the executor defaulted to its local mock; that makes no
  // sense in a serverless deployment). Override for mock-api testing.
  AEROAPI_BASE_URL: "https://aeroapi.flightaware.com/aeroapi",
};

function envOrDefault(name: keyof typeof TESTNET_DEFAULTS): string {
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
    // Settle cron: first AeroAPI look at an insured flight comes this long
    // after its scheduled arrival (public promise: settled within 24h of
    // ETA). Default 5h.
    settleAfterEtaSecs: parsePositiveInt(process.env.SETTLE_AFTER_ETA_SECS, 18_000),
    // JIT sale authorization. 0/unset horizon falls back to the routes
    // file's sale_horizon_days.
    saleAuthHorizonDays: parsePositiveInt(process.env.SALE_AUTH_HORIZON_DAYS, 0),
    saleAuthValiditySecs: Math.min(
      parsePositiveInt(process.env.SALE_AUTH_VALIDITY_SECS, 21_600), // 6h
      86_400 // on-chain cap — larger values would revert every open_sale
    ),
    // Purchase cutoff vs the scheduled departure. Default 24h.
    saleMinLeadSecs: parsePositiveInt(process.env.SALE_MIN_LEAD_SECS, 86_400),
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
  contractIds: {
    oracleAggregator: string;
    controller: string;
    riskVault: string;
    governance: string;
    flightPoolManager: string;
  };
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
