/**
 * e2e_live config — env from dapp/.env.e2e_live (never admin secrets),
 * contract IDs defaulting to deployments/testnet.json.
 *
 * The harness holds NO admin keys by design (spec: locked decisions) —
 * it can fund actors (friendbot), mint mock USDC (permissionless), and
 * drive the UI; every admin-gated step stays with the user.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAPP_ROOT = join(__dirname, "..", "..");
export const REPO_ROOT = join(DAPP_ROOT, "..");
export const RUNS_DIR = join(__dirname, "runs");

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*(#.*)?$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]!.trim();
  }
}

export interface LiveConfig {
  /** Deployed frontend (Vercel) — smoke target. */
  appUrl: string;
  /** Deployed backend origin for /api/* (usually same as appUrl). */
  backendUrl: string;
  /** ML service liveness probe (the service has no /health — use /docs). */
  renderHealthUrl: string;
  governanceDbUrl?: string;
  rpcUrl: string;
  networkPassphrase: string;
  horizonUrl: string;
  contracts: {
    controller: string;
    oracle: string;
    riskVault: string;
    governance: string;
    flightPoolManager: string;
    mockUsdc: string;
  };
  maxPolicies: number;
  headful: boolean;
  adminJwt?: string;
  /** Soak window in hours (reporting bound, not a hard stop). */
  soakHours: number;
}

export function loadLiveConfig(): LiveConfig {
  loadEnvFile(join(DAPP_ROOT, ".env.e2e_live"));
  loadEnvFile(join(DAPP_ROOT, ".env")); // fallback: GOVERNANCE_DB_URL etc.
  const deployment = JSON.parse(
    readFileSync(join(REPO_ROOT, "deployments", "testnet.json"), "utf8"),
  ) as { contracts: Record<string, { address: string }> };
  const c = deployment.contracts;
  const appUrl = process.env.DEPLOYED_APP_URL ?? "https://sentinel-dapp.vercel.app";
  return {
    appUrl,
    backendUrl: process.env.DEPLOYED_BACKEND_URL ?? appUrl,
    renderHealthUrl:
      process.env.RENDER_HEALTH_URL ?? "https://flight-delay-predictions.onrender.com/docs",
    governanceDbUrl: process.env.GOVERNANCE_DB_URL || undefined,
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    horizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    contracts: {
      controller: process.env.CONTROLLER_ID ?? c.controller!.address,
      oracle: process.env.ORACLE_AGGREGATOR_ID ?? c.oracle_aggregator!.address,
      riskVault: process.env.RISK_VAULT_ID ?? c.risk_vault!.address,
      governance: process.env.GOVERNANCE_ID ?? c.governance_module!.address,
      flightPoolManager: process.env.FLIGHT_POOL_MANAGER_ID ?? c.flight_pool_manager!.address,
      mockUsdc: process.env.MOCK_USDC_ID ?? c.mock_usdc!.address,
    },
    maxPolicies: Number(process.env.E2E_MAX_POLICIES ?? 56), // 50 planned + retry headroom
    headful: process.env.E2E_HEADFUL === "1",
    adminJwt: process.env.ADMIN_JWT || undefined,
    soakHours: Number(process.env.E2E_SOAK_HOURS ?? 48),
  };
}

export const USDC_UNITS = 10_000_000n; // 7 decimals
export const PAYOFF_UNITS = 100n * USDC_UNITS;
