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

// Defaults mirror deployments/testnet.json — the Phase 3 testnet set.
const TESTNET_DEFAULTS: Record<string, string> = {
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ORACLE_AGGREGATOR_ID: "CDOLYXPIV63FGRCIPOFZY5HNRS34QZHZJVEUUVJHSFEFW5H4CHQHJEYZ",
  CONTROLLER_ID: "CD7KCPQJFYSEUPJ43VXC6RIYCF4WPTVUHH3ANWNPYXTYGE2NBRXGFTXB",
  RISK_VAULT_ID: "CDW5YUJXGJWPVOQBXYVDZN7P7QQSE3U6VGIHBN24HZKKCS5QQ75OLIJE",
  GOVERNANCE_ID: "CB4GWBXFQ2TVHJVDYA7OOB7KNNASWCNNPW7BZDPYOCJZOBAXWK3B57VL",
  FLIGHT_POOL_MANAGER_ID: "CCEOYQREEASJ3F2EMNDJDP35ZXTMRVO3LKH3TGEZ6O2UDBCFVQNGDLWJ",
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
