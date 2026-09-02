import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../_lib/governance/db.js";
import { allowRequest, clientIp } from "../_lib/rate_limit.js";

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
  if (!(await allowRequest("vault-history", clientIp(req), 20))) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "rate limit exceeded — retry in a minute" });
    return;
  }

  // 2160h = 90 days: the headline APR window. It has to come from here and
  // not from RPC, because `get_snapshot_price` entries carry a 30-day TTL —
  // on-chain snapshots CANNOT answer a window longer than 30 days at all.
  const hours = Math.min(2160, Math.max(24, Number(req.query.hours) || 336));
  // Hourly buckets over 90 days would be 2160 rows for a two-point read.
  // Past a month, bucket by day instead — the long windows only ever feed
  // annualization, which reads the ends, not the shape.
  const daily = hours > 720;

  let rows: Array<{ ts: string; total_assets: string; share_price: string }> = [];
  let db_available = false;
  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const sql = getDb();
      // Two near-identical queries rather than an interpolated bucket
      // expression: the bucket feeds DISTINCT ON and ORDER BY, so it must
      // stay a literal the planner can index, never caller-shaped SQL.
      rows = (await (daily
        ? sql`
        select ts::text, total_assets::text, share_price::text
        from (
          select distinct on (date_trunc('day', ts)) ts, total_assets, share_price
          from vault_history
          where ts > now() - make_interval(hours => ${hours})
          order by date_trunc('day', ts), ts desc
        ) bucketed
        order by ts asc
      `
        : sql`
        select ts::text, total_assets::text, share_price::text
        from (
          select distinct on (date_trunc('hour', ts)) ts, total_assets, share_price
          from vault_history
          where ts > now() - make_interval(hours => ${hours})
          order by date_trunc('hour', ts), ts desc
        ) bucketed
        order by ts asc
      `)) as unknown as typeof rows;
      db_available = true;

      // Extend BACKWARDS with the daily share-price series for any day older
      // than the mirror's first row. The mirror only begins at the first
      // queue_maintainer run that wrote it, so on a long window it otherwise
      // measures the mirror's lifetime rather than the vault's — here that
      // meant annualizing from the vault's local peak and reporting a
      // negative APR for a vault that was up since inception.
      //
      // Only for long windows: the short ones feed chart shape, where mixing
      // hourly and daily resolution would just look like gaps.
      // total_assets is null on these rows — the on-chain snapshot records
      // share_price only — so consumers that need TVL must skip them.
      // Its own try: share_price_daily is created by the backfill script and
      // may simply not exist. A missing OPTIONAL extension must never cost
      // the caller the mirror rows we already have in hand.
      if (daily) {
        try {
          const firstTs = rows[0]?.ts ?? null;
          const backfill = (await sql`
            select day, share_price::text
            from share_price_daily
            where (${firstTs}::timestamptz is null
                   or to_timestamp(day * 86400) < ${firstTs}::timestamptz)
              and to_timestamp(day * 86400) > now() - make_interval(hours => ${hours})
            order by day asc
          `) as unknown as Array<{ day: number; share_price: string }>;
          if (backfill.length > 0) {
            rows = [
              ...backfill.map((b) => ({
                ts: new Date(Number(b.day) * 86_400_000).toISOString(),
                total_assets: null as unknown as string,
                share_price: b.share_price,
              })),
              ...rows,
            ];
          }
        } catch (err) {
          console.warn(`[vault-history-api] backfill extension unavailable: ${err}`);
        }
      }
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
