import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../_lib/governance/db.js";

/**
 * GET /api/status/vault-history — PUBLIC vault time series for the House
 * page sparklines (TVL + rolling APY), served from the vault_history
 * mirror the queue_maintainer cron appends to every run.
 *
 * Everything here is derived from public on-chain state, so exposing it
 * unauthenticated leaks nothing an RPC read wouldn't. Rows are
 * downsampled to the last sample of each HOUR — a 14-day window answers
 * with ≤336 points regardless of cron cadence.
 *
 * DB-OPTIONAL: no DB (or the table not yet created) → `rows: []` with
 * db_available:false, never a 500 — the frontend falls back to its
 * labelled illustrative series.
 *
 * ?hours=336 (default 14 days; clamped to [24, 720])
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const hours = Math.min(720, Math.max(24, Number(req.query.hours) || 336));

  let rows: Array<{ ts: string; total_assets: string; share_price: string }> = [];
  let db_available = false;
  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const sql = getDb();
      rows = (await sql`
        select ts::text, total_assets::text, share_price::text
        from (
          select distinct on (date_trunc('hour', ts)) ts, total_assets, share_price
          from vault_history
          where ts > now() - make_interval(hours => ${hours})
          order by date_trunc('hour', ts), ts desc
        ) hourly
        order by ts asc
      `) as unknown as typeof rows;
      db_available = true;
    } catch (err) {
      // table missing (mirror not yet written) or DB hiccup — degrade to
      // empty, the caller has an illustrative fallback
      console.warn(`[vault-history-api] read failed (degrading to empty): ${err}`);
    }
  }

  // History is append-only and HOURLY-bucketed: a 10-minute shared cache
  // can never be more than one bucket behind, and stale-while-revalidate
  // keeps answers instant while the CDN refreshes in the background.
  res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=3600");
  res.status(200).json({ rows, db_available, as_of: new Date().toISOString() });
}
