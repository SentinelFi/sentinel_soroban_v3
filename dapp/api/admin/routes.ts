import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { loadGovConfig } from "../_lib/governance/config";
import { getDb } from "../_lib/governance/db";
import { GovSubmitter } from "../_lib/governance/submitter";

/**
 * Admin API — route registry (DB rows; on-chain ops live in actions.ts).
 *
 * GET    → all routes; ?chain=1 adds live route_status per route
 * POST   → upsert a route's base terms / schedule / metadata
 * PATCH  → { action: "pin" | "unpin" | "set_status", ... }
 *
 * Pinning and lifecycle status are ADMIN DECISIONS the interventions
 * executor treats as law: pinned routes are untouchable by automated
 * causes, and admin holds are never auto-re-enabled.
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
      const routes = await sql`select * from routes order by flight_id, origin, dest`;
      if (req.query.chain === "1") {
        const config = loadGovConfig();
        const submitter = new GovSubmitter({
          rpcUrl: config.stellarRpcUrl,
          networkPassphrase: config.networkPassphrase,
          governanceId: config.governanceId,
          adminSecretKey: config.govAdminSecretKey,
          actor: `admin:${admin.email}`,
        });
        const withChain = [];
        for (const r of routes) {
          const onChain = await submitter
            .readStatus({ flightId: r.flight_id, origin: r.origin, dest: r.dest })
            .catch((err) => ({ status: "Unknown" as const, terms: null, error: String(err) }));
          withChain.push({
            ...r,
            on_chain: {
              status: onChain.status,
              terms: onChain.terms
                ? {
                    premium: onChain.terms.premium.toString(),
                    payoff: onChain.terms.payoff.toString(),
                    delay_hours: onChain.terms.delayHours,
                  }
                : null,
            },
          });
        }
        res.status(200).json({ routes: withChain });
        return;
      }
      res.status(200).json({ routes });
      return;
    }

    if (req.method === "POST") {
      const b = req.body ?? {};
      if (!b.flight_id || !b.origin || !b.dest) {
        res.status(400).json({ error: "Missing flight_id/origin/dest" });
        return;
      }
      const [row] = await sql`
        insert into routes
          (flight_id, origin, dest, carrier, base_premium_units, base_payoff_units,
           base_delay_hours, sched_dep_local, sched_arr_local, dep_tz, arr_tz, distance_mi)
        values
          (${b.flight_id}, ${b.origin}, ${b.dest}, ${b.carrier ?? null},
           ${b.base_premium_units ?? null}, ${b.base_payoff_units ?? null},
           ${b.base_delay_hours ?? null}, ${b.sched_dep_local ?? null},
           ${b.sched_arr_local ?? null}, ${b.dep_tz ?? null}, ${b.arr_tz ?? null},
           ${b.distance_mi ?? null})
        on conflict (flight_id, origin, dest) do update set
          carrier = excluded.carrier,
          base_premium_units = excluded.base_premium_units,
          base_payoff_units = excluded.base_payoff_units,
          base_delay_hours = excluded.base_delay_hours,
          sched_dep_local = excluded.sched_dep_local,
          sched_arr_local = excluded.sched_arr_local,
          dep_tz = excluded.dep_tz,
          arr_tz = excluded.arr_tz,
          distance_mi = excluded.distance_mi
        returning *
      `;
      res.status(200).json(row);
      return;
    }

    if (req.method === "PATCH") {
      const b = req.body ?? {};
      if (!b.flight_id || !b.origin || !b.dest) {
        res.status(400).json({ error: "Missing flight_id/origin/dest" });
        return;
      }
      const where = sql`flight_id = ${b.flight_id} and origin = ${b.origin} and dest = ${b.dest}`;

      let row;
      if (b.action === "pin") {
        [row] = await sql`
          update routes
          set pinned = true, pin_until = ${b.pin_until ?? null},
              pin_reason = ${"admin:" + admin.email + (b.pin_reason ? " — " + b.pin_reason : "")}
          where ${where} returning *
        `;
      } else if (b.action === "unpin") {
        [row] = await sql`
          update routes set pinned = false, pin_until = null, pin_reason = null
          where ${where} returning *
        `;
      } else if (b.action === "set_status") {
        if (!["candidate", "active", "disabled", "removed"].includes(b.status)) {
          res.status(400).json({ error: "Invalid status" });
          return;
        }
        [row] = await sql`update routes set status = ${b.status} where ${where} returning *`;
      } else {
        res.status(400).json({ error: "Invalid action" });
        return;
      }

      if (!row) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      res.status(200).json(row);
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
