import { getDb } from "./governance/db";

/**
 * flight_schedules — the scheduled dep/arr snapshot taken by the JIT
 * sale-authorization endpoint at buy time, one row per (flight, day).
 *
 * Its ONLY consumer is the settle cron's timing gate: "don't spend an API
 * call before scheduled arrival + settle delay". It is deliberately NOT
 * load-bearing for correctness — strictly DB-optional and fail-open:
 *   - no GOVERNANCE_DB_URL / DB down → writes are skipped, reads return
 *     null, and the settle cron falls back to flight date + 30h;
 *   - a retimed flight just means the first settle check comes early or
 *     late by the retiming delta — the check itself reads live data.
 * Self-creating table (one tiny ops table doesn't warrant a migration).
 */

export interface FlightScheduleRow {
  scheduledOutUnix: bigint | null;
  scheduledInUnix: bigint | null;
}

export async function saveFlightSchedule(
  flightId: string,
  dateUnix: bigint,
  scheduledOutUnix: bigint | null,
  scheduledInUnix: bigint | null
): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const sql = getDb();
    await sql`
      create table if not exists flight_schedules (
        flight_id text not null,
        date_unix bigint not null,
        scheduled_out_unix bigint,
        scheduled_in_unix bigint,
        fetched_at timestamptz not null default now(),
        primary key (flight_id, date_unix)
      )
    `;
    // FSA-H01: enable deny-all RLS on this self-created table (see the same
    // note in governance/interventions.ts). Without it the table is world
    // read/write via PostgREST using only the public key; the owning
    // postgres role bypasses RLS so server-side access is unaffected.
    await sql`alter table flight_schedules enable row level security`;
    await sql`
      insert into flight_schedules (flight_id, date_unix, scheduled_out_unix, scheduled_in_unix, fetched_at)
      values (${flightId}, ${dateUnix.toString()},
              ${scheduledOutUnix?.toString() ?? null}, ${scheduledInUnix?.toString() ?? null}, now())
      on conflict (flight_id, date_unix) do update
        set scheduled_out_unix = excluded.scheduled_out_unix,
            scheduled_in_unix = excluded.scheduled_in_unix,
            fetched_at = now()
    `;
  } catch (err) {
    console.warn(`[flight-schedules] save failed for ${flightId} (ignored): ${err}`);
  }
}

/** Scheduled gate arrival (unix secs) for a (flight, day), or null. */
export async function readScheduledArrival(
  flightId: string,
  dateUnix: bigint
): Promise<bigint | null> {
  if (!process.env.GOVERNANCE_DB_URL) return null;
  try {
    const sql = getDb();
    const rows = (await sql`
      select scheduled_in_unix from flight_schedules
      where flight_id = ${flightId} and date_unix = ${dateUnix.toString()}
    `) as unknown as Array<{ scheduled_in_unix: string | null }>;
    const raw = rows[0]?.scheduled_in_unix;
    return raw ? BigInt(raw) : null;
  } catch (err) {
    console.warn(`[flight-schedules] read failed for ${flightId} (ignored): ${err}`);
    return null;
  }
}
