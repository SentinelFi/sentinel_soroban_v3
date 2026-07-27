import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../_lib/governance/db";

/**
 * POST /api/sale-auth/warm — { flight_id, date } (UTC-midnight unix secs).
 *
 * Demand signal for the sale authorizer: the frontend calls this when a
 * user views a quote, marking the (flight, day) "hot". With
 * SALE_AUTH_DEMAND_MODE=true the authorizer's near window attests hot
 * days only, so an idle system spends ~zero near-window API calls.
 *
 * Deliberately unauthenticated (it's a quote-view breadcrumb) and
 * abuse-tolerant: rows cost nothing by themselves — the authorizer
 * intersects them with its own route/day grid, so warming unknown
 * flights or out-of-horizon days does nothing. Upsert refreshes
 * warmed_at; entries older than the demand TTL are ignored and pruned.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { flight_id, date } = (req.body ?? {}) as { flight_id?: unknown; date?: unknown };
  const dateNum = Number(date);
  if (typeof flight_id !== "string" || !/^[A-Z0-9]{2,10}$/.test(flight_id) || !Number.isInteger(dateNum) || dateNum <= 0 || dateNum % 86_400 !== 0) {
    res.status(400).json({ error: "expected { flight_id: string, date: UTC-midnight unix seconds }" });
    return;
  }
  try {
    const sql = getDb();
    await sql`
      insert into warm_windows (flight_id, date, warmed_at)
      values (${flight_id}, ${dateNum}, now())
      on conflict (flight_id, date) do update set warmed_at = now()
    `;
    res.status(200).json({ ok: true });
  } catch (err) {
    // No DB → demand mode is off anyway; report soft failure.
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
