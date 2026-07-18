import type { Config } from "./types";

/**
 * Env-driven config for the serverless cron functions.
 *
 * Same env var names as the executor (executor/centralized_cron), so a
 * .env can be moved between the two without renaming. Non-secret values
 * default to the Phase 3 testnet deployment (deployments/testnet.json,
 * deployed 2026-07-11); secrets are always required and never defaulted.
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
    aeroApiBaseUrl: envOrDefault("AEROAPI_BASE_URL"),
    aeroApiKey: process.env.AEROAPI_KEY ?? "",
  };
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
