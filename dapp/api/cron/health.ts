import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadPublicConfig } from "../_lib/config";
import { SorobanClient } from "../_lib/soroban_client";
import type { Config } from "../_lib/types";

/**
 * GET /api/cron/health — unauthenticated liveness/config probe.
 *
 * Reports which network + contract set the crons are wired to and whether
 * the three signing keys are configured — booleans only, secrets are
 * NEVER echoed.
 *
 * Also surfaces the protocol's single most important operational metric:
 * `pendingOutcomes` (oracle.get_pending_outcomes). Nonzero means the
 * vault's settlement barrier is engaged — every LP entry/exit is frozen
 * until the settler drains it. Monitors should alert on this staying
 * nonzero across more than ~2 settler cycles (10+ minutes), not merely on
 * cron success. Read is best-effort: null when the oracle key is unset or
 * the RPC read fails (the probe itself never errors on it).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const pub = loadPublicConfig();

  let pendingOutcomes: number | null = null;
  if (process.env.ORACLE_SECRET_KEY) {
    try {
      // Minimal config — readContract only needs RPC + passphrase + the
      // oracle id/key; loadConfig() would demand all three keeper secrets.
      const cfg = {
        stellarRpcUrl: pub.rpcUrl,
        networkPassphrase: pub.network,
        oracleAggregatorId: pub.contractIds.oracleAggregator,
        oracleSecretKey: process.env.ORACLE_SECRET_KEY,
      } as Config;
      const client = new SorobanClient(cfg);
      pendingOutcomes = Number(
        (await client.readContract(cfg.oracleAggregatorId, "get_pending_outcomes")) ?? 0
      );
    } catch (err) {
      console.warn(`[health] pending-outcomes read failed: ${err}`);
      pendingOutcomes = null;
    }
  }

  res.status(200).json({
    ok: true,
    network: pub.network,
    rpcUrl: pub.rpcUrl,
    contractIds: pub.contractIds,
    hasKeys: pub.hasKeys,
    // Settlement-barrier gauge: 0 = LP queues flowing; >0 = frozen until
    // settled; null = unreadable (no oracle key / RPC failure).
    pendingOutcomes,
    barrierEngaged: pendingOutcomes === null ? null : pendingOutcomes > 0,
  });
}
