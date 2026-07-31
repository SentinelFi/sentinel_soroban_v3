import type { VercelRequest } from "@vercel/node";
import { getDb } from "./governance/db";

/**
 * Fixed-window rate limiting for the public, unauthenticated endpoints
 * (OCA-M02). The sale-auth gate is deliberately open — but each novel
 * (flight, date) probe can cost a billed AeroAPI call plus oracle-signed
 * chain writes, so an anonymous caller walking the flight × date space
 * must be throttled.
 *
 * Two layers, both fixed one-minute windows:
 *   - DB-backed per-key counter (atomic conditional upsert — the same
 *     pooler-safe pattern as the gov_disable_slots budget) → holds across
 *     serverless instances;
 *   - in-memory per-instance counter → free fallback when the DB is
 *     absent (the endpoints stay DB-optional) or unreachable.
 *
 * Fail-open on DB errors by design: a DB blip must not close the public
 * storefront; the in-memory layer still bounds a single hot instance.
 */

const WINDOW_SECS = 60;

const memory = new Map<string, { windowStart: number; count: number }>();

function memoryAllow(bucket: string, limit: number, nowSecs: number): boolean {
  const windowStart = nowSecs - (nowSecs % WINDOW_SECS);
  // Opportunistic prune so the map never grows past one window of keys.
  if (memory.size > 10_000) {
    for (const [k, v] of memory) if (v.windowStart !== windowStart) memory.delete(k);
  }
  const entry = memory.get(bucket);
  if (!entry || entry.windowStart !== windowStart) {
    memory.set(bucket, { windowStart, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

async function dbAllow(bucket: string, limit: number): Promise<boolean | null> {
  if (!process.env.GOVERNANCE_DB_URL) return null;
  try {
    const sql = getDb();
    await sql`
      create table if not exists api_rate_limits (
        bucket text not null,
        window_start timestamptz not null,
        count int not null,
        primary key (bucket, window_start)
      )
    `;
    await sql`alter table api_rate_limits enable row level security`;
    await sql`delete from api_rate_limits where window_start < now() - interval '1 hour'`;
    const rows = (await sql`
      insert into api_rate_limits (bucket, window_start, count)
      values (${bucket}, date_trunc('minute', now()), 1)
      on conflict (bucket, window_start) do update
        set count = api_rate_limits.count + 1
        where api_rate_limits.count < ${limit}
      returning count
    `) as unknown as unknown[];
    return rows.length > 0;
  } catch (err) {
    console.warn(`[rate-limit] DB counter failed (${err}) — in-memory layer only.`);
    return null;
  }
}

/** Best-effort caller identity: first hop of x-forwarded-for (set by Vercel). */
export function clientIp(req: VercelRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

/**
 * True when the caller is within `limit` requests for the current
 * one-minute window of `scope:id`. Callers should reply 429 on false.
 */
export async function allowRequest(scope: string, id: string, limit: number): Promise<boolean> {
  const bucket = `${scope}:${id}`;
  const inMemory = memoryAllow(bucket, limit, Math.floor(Date.now() / 1000));
  const inDb = await dbAllow(bucket, limit);
  return inDb === null ? inMemory : inDb && inMemory;
}
