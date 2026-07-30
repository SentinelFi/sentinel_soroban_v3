import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { getDb } from "../_lib/governance/db";
import { ensureOutcomesTable } from "../_lib/outcome_log";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Admin API — flight_outcomes, read-only (the weather-learnability log
 * `_lib/outcome_log.ts` writes: one row per insured flight-day, pairing
 * the outcome with actual weather at both airports).
 *
 * GET → paginated rows: ?page=&limit=&outcome=ontime|delayed|cancelled|diverted
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const sql = getDb();
    const outcome = typeof req.query.outcome === "string" ? req.query.outcome.trim() : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
    const offset = (page - 1) * limit;

    await ensureOutcomesTable(sql); // may not exist yet if no outcome has ever been logged

    const where = outcome ? sql`where outcome = ${outcome}` : sql``;
    const rows = await sql`
      select *, count(*) over () as full_count from flight_outcomes
      ${where}
      order by flight_date desc, logged_at desc
      limit ${limit} offset ${offset}
    `;
    const total = rows.length > 0 ? Number(rows[0].full_count) : 0;
    const clean = rows.map(({ full_count, ...r }) => r);

    res.status(200).json({ rows: clean, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
