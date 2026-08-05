import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "./_lib/governance/db.js";
import { allowRequest, clientIp } from "./_lib/rate_limit.js";

/**
 * POST /api/flight-schedules — { items: [{ flight_id, date }] } (date =
 * UTC-midnight unix seconds, the on-chain bucket key; ≤100 items).
 *
 * Display-only batch read over the `flight_schedules` snapshot table the
 * sale-auth endpoint writes at buy time, so the UI can show scheduled
 * departure times (BetSlip after a date is picked, Policies rows). Same
 * posture as its source: strictly DB-optional and fail-open — no DB, no
 * table, or no row for a pair just means that pair is absent from the
 * response and the UI shows nothing. Never spends an AeroAPI call.
 */

interface ScheduleItem {
  flight_id: string;
  date: number;
}

function parseItems(body: unknown): ScheduleItem[] | null {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return null;
  const out: ScheduleItem[] = [];
  for (const raw of items) {
    const { flight_id, date } = (raw ?? {}) as { flight_id?: unknown; date?: unknown };
    const dateNum = Number(date);
    if (
      typeof flight_id !== "string" ||
      !/^[A-Z0-9]{2,10}$/.test(flight_id) ||
      !Number.isInteger(dateNum) ||
      dateNum <= 0 ||
      dateNum % 86_400 !== 0
    ) {
      return null;
    }
    out.push({ flight_id, date: dateNum });
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // Cheap DB read, but still public and unauthenticated — bound it.
  if (!(await allowRequest("flight-schedules", clientIp(req), 30))) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "rate limit exceeded — retry in a minute" });
    return;
  }
  const items = parseItems(req.body);
  if (!items) {
    res.status(400).json({
      error: "expected { items: [{ flight_id: string, date: UTC-midnight unix seconds }] } (≤100)",
    });
    return;
  }
  if (!process.env.GOVERNANCE_DB_URL) {
    res.status(200).json({ schedules: [] });
    return;
  }
  try {
    const sql = getDb();
    const flightIds = [...new Set(items.map((i) => i.flight_id))];
    const dates = [...new Set(items.map((i) => String(i.date)))];
    const rows = (await sql`
      select flight_id, date_unix, scheduled_out_unix, scheduled_in_unix
      from flight_schedules
      where flight_id = any(${flightIds}) and date_unix = any(${dates}::bigint[])
    `) as unknown as Array<{
      flight_id: string;
      date_unix: string;
      scheduled_out_unix: string | null;
      scheduled_in_unix: string | null;
    }>;
    // any() × any() over-matches across pairs — keep only requested pairs.
    const wanted = new Set(items.map((i) => `${i.flight_id}:${i.date}`));
    const schedules = rows
      .filter((r) => wanted.has(`${r.flight_id}:${r.date_unix}`))
      .map((r) => ({
        flight_id: r.flight_id,
        date: Number(r.date_unix),
        scheduled_out: r.scheduled_out_unix != null ? Number(r.scheduled_out_unix) : null,
        scheduled_in: r.scheduled_in_unix != null ? Number(r.scheduled_in_unix) : null,
      }));
    res.status(200).json({ schedules });
  } catch (err) {
    // Missing table / DB blip — this is display garnish, fail open to "unknown".
    console.warn(`[flight-schedules] batch read failed (ignored): ${err}`);
    res.status(200).json({ schedules: [] });
  }
}
