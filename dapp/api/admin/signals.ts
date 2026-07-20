import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { getDb } from "../_lib/governance/db";

/**
 * Admin API — signals.
 *
 * GET    → active signals (plus last 50 ended, for context)
 * POST   → declare a signal (geopolitical pause, manual override, …)
 * PATCH  → clear a signal ({ id })
 *
 * Declared signals are FACTS, not actions: the reconciler picks them up
 * on its next tick and does the on-chain work through the audited
 * pipeline. severity 'severe' pauses matching routes; 'elevated'
 * multiplies premiums (payload.factor).
 */

const SIGNAL_TYPES = new Set(["weather", "geopolitical", "exposure", "schedule_drift", "manual"]);
const SCOPES = new Set(["route", "origin", "dest"]);
const SEVERITIES = new Set(["info", "elevated", "severe"]);

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const sql = getDb();

  try {
    if (req.method === "GET") {
      const active = await sql`
        select * from signals
        where cleared_at is null and (expires_at is null or expires_at > now())
        order by created_at desc
      `;
      const ended = await sql`
        select * from signals
        where cleared_at is not null or expires_at <= now()
        order by coalesce(cleared_at, expires_at) desc
        limit 50
      `;
      res.status(200).json({ active, ended });
      return;
    }

    if (req.method === "POST") {
      const b = req.body ?? {};
      if (!SIGNAL_TYPES.has(b.type) || !SCOPES.has(b.scope_kind) || !SEVERITIES.has(b.severity)) {
        res.status(400).json({ error: "Invalid type/scope_kind/severity" });
        return;
      }
      const scopeOk =
        b.scope_kind === "route"
          ? b.flight_id && b.origin && b.dest
          : b.scope_kind === "origin"
            ? Boolean(b.origin)
            : Boolean(b.dest);
      if (!scopeOk) {
        res.status(400).json({ error: `Missing scope fields for scope_kind=${b.scope_kind}` });
        return;
      }
      const [row] = await sql`
        insert into signals (type, scope_kind, flight_id, origin, dest, severity, payload, source, expires_at)
        values (${b.type}, ${b.scope_kind}, ${b.flight_id ?? null}, ${b.origin ?? null},
                ${b.dest ?? null}, ${b.severity}, ${sql.json(b.payload ?? {})},
                ${"admin:" + admin.email}, ${b.expires_at ?? null})
        returning *
      `;
      res.status(201).json(row);
      return;
    }

    if (req.method === "PATCH") {
      const id = req.body?.id;
      if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
      }
      const [row] = await sql`
        update signals set cleared_at = now()
        where id = ${id} and cleared_at is null
        returning *
      `;
      if (!row) {
        res.status(404).json({ error: "Signal not found or already cleared" });
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
