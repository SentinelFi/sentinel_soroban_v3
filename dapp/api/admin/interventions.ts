import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { loadGovConfig } from "../_lib/governance/config.js";
import { getDb } from "../_lib/governance/db.js";
import {
  pauseRoute,
  reviveRoute,
  type GovChainConfig,
  type InterventionRow,
} from "../_lib/governance/interventions.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Admin API — the interventions ledger (replaces the signals API).
 *
 * GET    → paginated ledger: ?state=open|closed (default open) &page=
 *          &limit= &cause= — the "what's paused/unpaused and why" view.
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

/** Optional dependency injection seam — tests pass fakes, production omits. */
export interface InterventionsDeps {
  verifyAdmin?: typeof verifyAdmin;
  loadGovConfig?: typeof loadGovConfig;
}

export async function handler(
  req: VercelRequest,
  res: VercelResponse,
  deps: InterventionsDeps = {}
): Promise<void> {
  const admin = await (deps.verifyAdmin ?? verifyAdmin)(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const actor = `admin:${admin.email}`;

  try {
    const sql = getDb();

    if (req.method === "GET") {
      const state = req.query.state === "closed" ? "closed" : "open";
      const cause = typeof req.query.cause === "string" ? req.query.cause.trim() : "";
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
      const offset = (page - 1) * limit;

      const conditions = [state === "open" ? sql`revived_at is null` : sql`revived_at is not null`];
      if (cause) conditions.push(sql`cause = ${cause}`);
      const where = sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}`;
      const orderBy = state === "open" ? sql`opened_at desc` : sql`revived_at desc`;

      const rows = await sql`
        select *, count(*) over () as full_count from interventions
        ${where}
        order by ${orderBy}
        limit ${limit} offset ${offset}
      `.catch(() => []);
      const total = Number(rows[0]?.full_count ?? 0);
      const clean = rows.map(({ full_count, ...r }) => r);

      const openRows = (await sql`
        select count(*)::int as open_count from interventions where revived_at is null
      `.catch(() => [])) as Array<{ open_count: number }>;
      const open_count = openRows[0]?.open_count ?? 0;

      res.status(200).json({ rows: clean, total, page, limit, state, open_count });
      return;
    }

    const chainConfig: GovChainConfig = (() => {
      const c = (deps.loadGovConfig ?? loadGovConfig)();
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
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: "no open intervention with that id" });
        return;
      }
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

export default function (req: VercelRequest, res: VercelResponse): Promise<void> {
  return handler(req, res);
}
