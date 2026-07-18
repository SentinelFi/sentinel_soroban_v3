import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadPublicConfig } from "../_lib/config";

/**
 * GET /api/cron/health — unauthenticated liveness/config probe.
 *
 * Reports which network + contract set the crons are wired to and whether
 * the three signing keys are configured — booleans only, secrets are
 * NEVER echoed.
 */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const pub = loadPublicConfig();
  res.status(200).json({
    ok: true,
    network: pub.network,
    rpcUrl: pub.rpcUrl,
    contractIds: pub.contractIds,
    hasKeys: pub.hasKeys,
  });
}
