import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as ControllerClient } from "controller";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { loadGovConfig } from "../_lib/governance/config.js";
import { loadPublicConfig } from "../_lib/config.js";
import { GovSubmitter } from "../_lib/governance/submitter.js";
import { logAction } from "../_lib/governance/action_log.js";

/**
 * Admin API — direct protocol controls that go BEYOND the interventions
 * ledger (which only disables/enables routes):
 *
 *   remove_route  — GovernanceModule.remove_route via GovSubmitter (the
 *                   contract enforces disabled-first, so the ledger's
 *                   pause flow is the mandatory prelude);
 *   buyer_add     — Controller.add_whitelisted_buyer (gov-admin key is
 *                   authorized: "owner or any GovernanceModule admin");
 *   buyer_remove  — Controller.remove_whitelisted_buyer (same auth).
 *
 * Deliberately NOT here: contract pause/unpause and the whitelist gate
 * toggle (set_whitelist_enabled). Those are owner-only on-chain and the
 * owner secret never reaches this deployment — the admin UI signs them
 * with the connected owner wallet instead.
 *
 * POST → { action, ... } — every mutation is audited in actions_log
 * with actor `admin:<email>`, same as the interventions executor.
 */

export const config = { maxDuration: 60 };

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const MAX_FEE = "10000000";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const actor = `admin:${admin.email}`;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const action = String(b.action ?? "");

  if (!process.env.GOVERNANCE_ADMIN_SECRET_KEY) {
    res.status(503).json({ error: "GOVERNANCE_ADMIN_SECRET_KEY not configured" });
    return;
  }

  try {
    const gov = loadGovConfig();

    if (action === "remove_route") {
      const { flight_id, origin, dest } = b as Record<string, string>;
      if (!flight_id || !origin || !dest) {
        res.status(400).json({ error: "expected { flight_id, origin, dest }" });
        return;
      }
      const submitter = new GovSubmitter({
        rpcUrl: gov.stellarRpcUrl,
        networkPassphrase: gov.networkPassphrase,
        governanceId: gov.governanceId,
        adminSecretKey: gov.govAdminSecretKey,
        actor,
      });
      const outcome = await submitter.remove({ flightId: flight_id, origin, dest });
      res.status(200).json({ ok: true, tx_hash: outcome.txHash });
      return;
    }

    if (action === "buyer_add" || action === "buyer_remove") {
      const addr = String(b.addr ?? "").trim().toUpperCase();
      if (!STELLAR_ADDRESS.test(addr)) {
        res.status(400).json({ error: "expected { addr } — a valid G… address" });
        return;
      }
      const keypair = Keypair.fromSecret(gov.govAdminSecretKey);
      const caller = keypair.publicKey();
      const controller = new ControllerClient({
        contractId: loadPublicConfig().contractIds.controller,
        networkPassphrase: gov.networkPassphrase,
        rpcUrl: gov.stellarRpcUrl,
        publicKey: caller,
        ...basicNodeSigner(keypair, gov.networkPassphrase),
      });
      const method =
        action === "buyer_add" ? "add_whitelisted_buyer" : "remove_whitelisted_buyer";
      let txHash: string | null = null;
      try {
        const tx =
          action === "buyer_add"
            ? await controller.add_whitelisted_buyer({ caller, addr }, { fee: MAX_FEE })
            : await controller.remove_whitelisted_buyer({ caller, addr }, { fee: MAX_FEE });
        const sent = await tx.signAndSend();
        txHash =
          (sent as { sendTransactionResponse?: { hash?: string } }).sendTransactionResponse
            ?.hash ?? null;
      } catch (err) {
        await safeBuyerLog(actor, method, addr, null, false, String(err));
        throw err;
      }
      await safeBuyerLog(actor, method, addr, txHash, true, null);
      res.status(200).json({ ok: true, tx_hash: txHash });
      return;
    }

    res.status(400).json({ error: `unknown action "${action}"` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** actions_log write for buyer-whitelist mutations — audit must never
 *  mask the on-chain outcome (same posture as GovSubmitter). */
async function safeBuyerLog(
  actor: string,
  action: string,
  addr: string,
  txHash: string | null,
  success: boolean,
  error: string | null
): Promise<void> {
  try {
    await logAction({
      actor,
      action,
      txHash,
      before: { addr },
      success,
      error,
    });
  } catch (err) {
    console.error(`[admin-controls] actions_log write failed for ${action}: ${err}`);
  }
}
