import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isAuthorized } from "../handler.js";
import type { RunLogEntry } from "../types.js";
import { cronTrigger, recordRun } from "./runs.js";

/**
 * Config + handler wrapper for the governance crons (gov-reconcile,
 * gov-signals, …). Separate from ../config.ts on purpose: those jobs
 * require oracle/keeper/ttl secrets that the governance crons never
 * touch — a gov cron must not 500 because an unrelated key is unset.
 *
 * Env (same testnet defaults as ../config.ts):
 * - GOVERNANCE_ID, STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE
 * - GOVERNANCE_ADMIN_SECRET_KEY — the gov-admin key (sentinel-governor)
 * - GOVERNANCE_DB_URL — checked by db.ts at first query
 * - GOV_DRY_RUN=true — compute and log decisions, submit nothing and
 *   write no DB state; for pre-add_admin testing and safe rollouts.
 */

const TESTNET_DEFAULTS = {
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  // 2026-07-18 testnet deployment (matches _lib/config.ts + the frontend).
  // NOTE: the gov-admin add_admin on this module is still pending the owner
  // key — keep GOV_DRY_RUN=true until it lands.
  GOVERNANCE_ID: "CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE",
};

export interface GovConfig {
  stellarRpcUrl: string;
  networkPassphrase: string;
  governanceId: string;
  govAdminSecretKey: string;
  dryRun: boolean;
}

export function loadGovConfig(): GovConfig {
  const secret = process.env.GOVERNANCE_ADMIN_SECRET_KEY;
  if (!secret) {
    throw new Error("Missing required env var: GOVERNANCE_ADMIN_SECRET_KEY");
  }
  return {
    stellarRpcUrl: process.env.STELLAR_RPC_URL ?? TESTNET_DEFAULTS.STELLAR_RPC_URL,
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET_DEFAULTS.STELLAR_NETWORK_PASSPHRASE,
    governanceId: process.env.GOVERNANCE_ID ?? TESTNET_DEFAULTS.GOVERNANCE_ID,
    govAdminSecretKey: secret,
    dryRun: process.env.GOV_DRY_RUN === "true",
  };
}

/** Same contract as makeCronHandler, but for GovConfig jobs. */
export function makeGovCronHandler(run: (config: GovConfig) => Promise<RunLogEntry>) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let config: GovConfig;
    try {
      config = loadGovConfig();
    } catch (err) {
      res.status(500).json({ error: `Config error: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    try {
      const entry = await run(config);
      await recordRun(entry, cronTrigger(req.headers));
      res.status(entry.success ? 200 : 500).json(entry);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}
