import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { loadGovConfig } from "../_lib/governance/config";
import { getDb } from "../_lib/governance/db";
import { GovSubmitter, type DelayOp, type PremiumOp } from "../_lib/governance/submitter";

/**
 * Admin API — on-chain governance operations + audit trail.
 *
 * GET  → actions_log tail (?limit=, default 100, max 500)
 * POST → { op, flight_id, origin, dest, ...op-specific }
 *   whitelist  { premium_units?, payoff_units?, delay_hours? }  null → on-chain defaults
 *   disable    {}
 *   enable     {}
 *   remove     {}
 *   set_terms  { premium_units?, payoff_units?, delay_hours? }  omitted → Keep, "default" → UseDefault
 *   revert     {}                                                all fields → UseDefault
 *
 * Admin clicks go through the SAME GovSubmitter pipeline as the cron
 * rules — identical audit rows, actor = admin:<email>. The route's DB
 * lifecycle row is kept in step so the reconciler and the UI agree.
 */

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const sql = getDb();

  try {
    if (req.method === "GET") {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const log = await sql`select * from actions_log order by ts desc limit ${limit}`;
      res.status(200).json({ log });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const b = req.body ?? {};
    if (!b.flight_id || !b.origin || !b.dest) {
      res.status(400).json({ error: "Missing flight_id/origin/dest" });
      return;
    }
    const key = { flightId: b.flight_id, origin: b.origin, dest: b.dest };

    const config = loadGovConfig();
    const submitter = new GovSubmitter({
      rpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      adminSecretKey: config.govAdminSecretKey,
      actor: `admin:${admin.email}`,
    });

    const setLifecycle = (status: string) => sql`
      update routes set status = ${status}
      where flight_id = ${b.flight_id} and origin = ${b.origin} and dest = ${b.dest}
    `;

    let outcome;
    switch (b.op) {
      case "whitelist":
        outcome = await submitter.whitelist(
          key,
          b.premium_units ? BigInt(b.premium_units) : null,
          b.payoff_units ? BigInt(b.payoff_units) : null,
          b.delay_hours ?? null
        );
        await setLifecycle("active");
        break;
      case "disable":
        outcome = await submitter.disable(key);
        await setLifecycle("disabled");
        break;
      case "enable":
        outcome = await submitter.enable(key);
        await setLifecycle("active");
        break;
      case "remove":
        outcome = await submitter.remove(key);
        await setLifecycle("removed");
        break;
      case "set_terms":
        outcome = await submitter.updateTerms(
          key,
          parseFieldOp(b.premium_units),
          parseFieldOp(b.payoff_units),
          parseDelayOp(b.delay_hours)
        );
        break;
      case "revert":
        outcome = await submitter.revertTerms(key);
        break;
      default:
        res.status(400).json({ error: `Invalid op: ${b.op}` });
        return;
    }

    res.status(200).json({
      tx_hash: outcome.txHash,
      before: jsonRoute(outcome.before),
      after: jsonRoute(outcome.after),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** omitted/undefined → Keep; "default" → UseDefault; value → Set. */
function parseFieldOp(v: unknown): PremiumOp {
  if (v === undefined || v === null || v === "keep") return "keep";
  if (v === "default") return "use_default";
  return BigInt(v as string | number);
}

function parseDelayOp(v: unknown): DelayOp {
  if (v === undefined || v === null || v === "keep") return "keep";
  if (v === "default") return "use_default";
  return Number(v);
}

function jsonRoute(r: { status: string; terms: { premium: bigint; payoff: bigint; delayHours: number } | null }) {
  return {
    status: r.status,
    terms: r.terms
      ? {
          premium: r.terms.premium.toString(),
          payoff: r.terms.payoff.toString(),
          delay_hours: r.terms.delayHours,
        }
      : null,
  };
}
