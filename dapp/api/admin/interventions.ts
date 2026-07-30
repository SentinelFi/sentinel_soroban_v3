import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { loadGovConfig } from "../_lib/governance/config";
import { getDb } from "../_lib/governance/db";
import {
  pauseRoute,
  reviveRoute,
  type GovChainConfig,
  type InterventionRow,
} from "../_lib/governance/interventions";

/**
 * Admin API — the interventions ledger (replaces the signals API).
 *
 * GET    → open interventions + the last 50 closed (context)
 * POST   → pause a route by hand: { flight_id, origin, dest, reason }
 *          — an `admin` intervention; NEVER auto-revived.
 * PATCH  → revive by id: { id } — closes that row (any cause; this is
 *          the human override), re-enabling the route if it was the
 *          last open hold.
 *
 * Both mutations run through the same executor every automated detector
 * uses, so the chain write is identically audited (actions_log, actor
 * `admin:<email>`).
 */

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const actor = `admin:${admin.email}`;

  try {
    const sql = getDb();

    if (req.method === "GET") {
      const open = await sql`
        select * from interventions where revived_at is null order by opened_at desc
      `.catch(() => []);
      const closed = await sql`
        select * from interventions where revived_at is not null
        order by revived_at desc limit 50
      `.catch(() => []);
      res.status(200).json({ open, closed });
      return;
    }

    const chainConfig: GovChainConfig = (() => {
      const c = loadGovConfig();
      return {
        stellarRpcUrl: c.stellarRpcUrl,
        networkPassphrase: c.networkPassphrase,
        governanceId: c.governanceId,
        governanceAdminSecretKey: c.govAdminSecretKey,
      };
    })();

    if (req.method === "POST") {
      const b = req.body ?? {};
      if (!b.flight_id || !b.origin || !b.dest || !b.reason) {
        res.status(400).json({ error: "expected { flight_id, origin, dest, reason }" });
        return;
      }
      const result = await pauseRoute(
        chainConfig,
        { flight_id: b.flight_id, origin: b.origin, destination: b.dest },
        "admin",
        { reason: b.reason },
        actor
      );
      res.status(200).json({ ok: true, outcome: result.outcome });
      return;
    }

    if (req.method === "PATCH") {
      const id = req.body?.id;
      if (!id) {
        res.status(400).json({ error: "expected { id }" });
        return;
      }
      const rows = (await sql`
        select * from interventions where id = ${id} and revived_at is null
      `) as unknown as InterventionRow[];
      if (rows.length === 0) {
        res.status(404).json({ error: "no open intervention with that id" });
        return;
      }
      const row = rows[0];
      const outcome = await reviveRoute(
        chainConfig,
        { flight_id: row.flight_id, origin: row.origin, destination: row.dest },
        row.cause,
        actor
      );
      res.status(200).json({ ok: true, outcome });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
