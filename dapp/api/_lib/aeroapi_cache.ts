import { getDb } from "./governance/db";

/**
 * Best-effort AeroAPI response cache over the governance DB
 * (`aeroapi_cache` table). Honors the DB-OPTIONAL invariant strictly:
 *
 * - no GOVERNANCE_DB_URL          → straight to the fetcher
 * - DB read fails                 → straight to the fetcher (warn)
 * - cache stale / miss            → fetcher, then best-effort store
 * - fetcher returns null          → nothing stored (never cache failures)
 *
 * The cache can only ever SAVE API calls — a dead database costs nothing
 * but the saving.
 */
export async function cachedFetch<T>(
  cacheKey: string,
  ttlSecs: number,
  fetcher: () => Promise<T | null>
): Promise<T | null> {
  const dbEnabled = Boolean(process.env.GOVERNANCE_DB_URL);

  if (dbEnabled) {
    try {
      const sql = getDb();
      const rows = (await sql`
        select payload from aeroapi_cache
        where cache_key = ${cacheKey}
          and fetched_at > now() - make_interval(secs => ${ttlSecs})
      `) as unknown as Array<{ payload: T }>;
      if (rows.length > 0) {
        return rows[0].payload;
      }
    } catch (err) {
      console.warn(`[aeroapi-cache] read failed (${err}) — fetching directly.`);
    }
  }

  const fresh = await fetcher();
  if (fresh !== null && dbEnabled) {
    try {
      const sql = getDb();
      await sql`
        insert into aeroapi_cache (cache_key, payload, fetched_at)
        values (${cacheKey}, ${sql.json(fresh as never)}, now())
        on conflict (cache_key) do update
          set payload = ${sql.json(fresh as never)}, fetched_at = now()
      `;
    } catch (err) {
      console.warn(`[aeroapi-cache] store failed (${err}) — result still used.`);
    }
  }
  return fresh;
}
