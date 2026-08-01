import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { loadGovConfig } from "../_lib/governance/config";
import { getDb } from "../_lib/governance/db";
import { GovSubmitter } from "../_lib/governance/submitter";
import { ensureTable as ensureInterventionsTable } from "../_lib/governance/interventions";

/**
 * Admin API — route registry (DB rows; on-chain ops live in actions.ts).
 *
 * GET    → paginated routes (?q=&page=&limit=&cause=); ?chain=1 adds live
 *          route_status per route ON THE RETURNED PAGE ONLY — never the
 *          whole fleet, so this stays flat as the route count grows.
 * POST   → upsert a route's base terms / schedule / metadata
 * PATCH  → { action: "pin" | "unpin" | "set_status", ... }
 *
 * Pinning and lifecycle status are ADMIN DECISIONS the interventions
 * executor treats as law: pinned routes are untouchable by automated
 * causes, and admin holds are never auto-re-enabled.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const sql = getDb();

  try {
    if (req.method === "GET") {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const cause = typeof req.query.cause === "string" ? req.query.cause.trim() : "";
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
      const offset = (page - 1) * limit;

      const conditions = [];
      if (q) {
        const pattern = `%${q}%`;
        conditions.push(
          sql`(r.flight_id ilike ${pattern} or r.origin ilike ${pattern} or r.dest ilike ${pattern} or r.carrier ilike ${pattern})`
        );
      }
      if (cause) conditions.push(sql`i.cause = ${cause}`);
      const where = conditions.length
        ? sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}`
        : sql``;

      await ensureInterventionsTable(sql); // may not exist yet on a fresh DB

      const routes = await sql`
        select r.*, count(*) over () as full_count,
          i.id as open_intervention_id, i.cause as open_cause,
          i.evidence as open_evidence, i.opened_at as open_opened_at
        from routes r
        left join lateral (
          select id, cause, evidence, opened_at from interventions
          where flight_id = r.flight_id and origin = r.origin and dest = r.dest
            and revived_at is null
          order by opened_at desc limit 1
        ) i on true
        ${where}
        order by r.flight_id, r.origin, r.dest
        limit ${limit} offset ${offset}
      `;
      const total = Number(routes[0]?.full_count ?? 0);
      const cleanRoutes = routes.map(({ full_count, ...r }) => r);

      const fleetTotalRows = (await sql`
        select count(*)::int as fleet_total from routes
      `) as Array<{ fleet_total: number }>;
      const fleet_total = fleetTotalRows[0]?.fleet_total ?? 0;
      const fleetActiveRows = (await sql`
        select count(*)::int as fleet_active from routes where status in ('active', 'disabled')
      `) as Array<{ fleet_active: number }>;
      const fleet_active = fleetActiveRows[0]?.fleet_active ?? 0;

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
        for (const r of cleanRoutes) {
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
        res.status(200).json({ routes: withChain, total, page, limit, fleet_total, fleet_active });
        return;
      }
      res.status(200).json({ routes: cleanRoutes, total, page, limit, fleet_total, fleet_active });
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
