import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadRoutesConfig, fileTerms } from "./_lib/routes_config.js";
import { getDb } from "./_lib/governance/db.js";
import liveConfig from "../config/routes.live.json";

/**
 * GET /api/routes — the full route catalog for the board.
 *
 * Replaces the browser-side per-route on-chain scan (1 RPC simulate per
 * listed route per visitor — the reason the board used to be capped at a
 * hand-curated list). One CDN-cached JSON blob serves every visitor.
 *
 * Sources, layered:
 *   1. bundled fleet file (config/routes.testnet.json) — the complete
 *      seeded catalog with per-route term overrides mirrored from chain
 *      at seed time; enabled=false entries are excluded;
 *   2. governance DB `routes` overlay — the interventions executor and
 *      revive cron write pauses/re-enables here INTRADAY, so a DB
 *      "disabled" wins over the file default (fresher than any cached
 *      chain read); DB unreachable → file-only (fail-open to display,
 *      fail-safe overall: sale-auth + the contract re-verify every buy);
 *   3. routes.live.json — demoted from "the only inventory" to the
 *      `featured` flag (board pins featured rows first).
 *
 * The authoritative buyability check stays at buy time (sale-auth + the
 * on-chain purchase gate) — a stale row here surfaces a refusal, never a
 * bad policy.
 */
export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const routesConfig = loadRoutesConfig();
  const featured = new Set(
    ((liveConfig as { routes?: Array<{ flight_id: string; origin: string; destination: string }> })
      .routes ?? []).map((r) => `${r.flight_id}|${r.origin}|${r.destination}`),
  );

  // DB overlay — best effort, never blocks the catalog.
  const dbStatus = new Map<string, string>();
  let dbOverlay = false;
  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const sql = getDb();
      const rows = (await sql`select flight_id, origin, dest, status from routes`) as unknown as Array<{
        flight_id: string;
        origin: string;
        dest: string;
        status: string;
      }>;
      for (const r of rows) dbStatus.set(`${r.flight_id}|${r.origin}|${r.dest}`, r.status);
      dbOverlay = true;
    } catch {
      /* file-only */
    }
  }

  const routes = routesConfig.routes
    .filter((r) => r.enabled !== false)
    .map((r) => {
      const key = `${r.flight_id}|${r.origin}|${r.destination}`;
      const overlay = dbStatus.get(key);
      const terms = fileTerms(routesConfig, r);
      return {
        flight_id: r.flight_id,
        origin: r.origin,
        destination: r.destination,
        carrier: r.carrier ?? null,
        status: overlay === "disabled" ? "Disabled" : "Active",
        premium_units: terms.premium.toString(),
        payoff_units: terms.payoff.toString(),
        delay_hours: terms.delayHours,
        featured: featured.has(key),
      };
    });

  // One origin fetch per 5min globally; browsers keep it 1min.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({
    as_of: new Date().toISOString(),
    db_overlay: dbOverlay,
    count: routes.length,
    routes,
  });
}
