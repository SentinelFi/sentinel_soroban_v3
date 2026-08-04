/**
 * Read-only governance-DB access (what the cron pipeline believed/did).
 * Reuses the api getDb() — needs GOVERNANCE_DB_URL (from .env.e2e_live
 * or the dapp .env fallback). Every helper degrades to null when the DB
 * is unreachable so `check` keeps working offline; the report marks DB
 * columns "unavailable" instead of failing money assertions.
 */
import { getDb } from "../../api/_lib/governance/db.js";

export interface CronRunRow {
  job: string;
  started_at: Date;
  success: boolean;
  detail: string | null;
}

async function tryQuery<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export function dbAvailable(): boolean {
  return Boolean(process.env.GOVERNANCE_DB_URL);
}

export async function recentCronRuns(sinceIso: string): Promise<CronRunRow[] | null> {
  if (!dbAvailable()) return null;
  return tryQuery(async () => {
    const sql = getDb();
    const rows = await sql`
      select job, started_at, success, detail from cron_runs
      where started_at >= ${sinceIso} order by started_at desc limit 2000`;
    return rows as unknown as CronRunRow[];
  });
}

export async function settlementsFor(flightIds: string[]): Promise<Record<string, unknown>[] | null> {
  if (!dbAvailable() || flightIds.length === 0) return null;
  return tryQuery(async () => {
    const sql = getDb();
    const rows = await sql`
      select * from settlements where flight_id = any(${flightIds}) order by created_at`;
    return rows as unknown as Record<string, unknown>[];
  });
}

export async function outcomesFor(flightIds: string[]): Promise<Record<string, unknown>[] | null> {
  if (!dbAvailable() || flightIds.length === 0) return null;
  return tryQuery(async () => {
    const sql = getDb();
    const rows = await sql`
      select * from flight_outcomes where flight_id = any(${flightIds}) order by created_at`;
    return rows as unknown as Record<string, unknown>[];
  });
}

export async function openInterventions(): Promise<Record<string, unknown>[] | null> {
  if (!dbAvailable()) return null;
  return tryQuery(async () => {
    const sql = getDb();
    const rows = await sql`
      select * from interventions where resolved_at is null order by created_at`;
    return rows as unknown as Record<string, unknown>[];
  });
}

export async function closeDb(): Promise<void> {
  if (!dbAvailable()) return;
  try {
    await getDb().end({ timeout: 3 });
  } catch {
    /* already closed */
  }
}
