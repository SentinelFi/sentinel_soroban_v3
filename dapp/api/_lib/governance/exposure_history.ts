import { getDb } from "./db.js";

/**
 * exposure_history — the risk book's time series, appended by the hourly
 * gov_exposure cron on every successfully MEASURED run (including
 * dry-run: recording what was observed is a mirror write, not a
 * governance action).
 *
 * vault_history answers "where is the LP money"; this answers "what has
 * the protocol PROMISED against it" — open policy count, total live
 * liability, and how concentrated the worst route/airport bucket sits
 * relative to the 25%/50% brake thresholds. Together they are the two
 * halves the Trends board needs to show pricing and risk drift over
 * time; neither is reconstructable later (RPC events expire in ~7 days).
 *
 * DB-OPTIONAL and never load-bearing: a write failure is console-logged
 * and the exposure job continues untouched.
 */

/** i128 unit columns are stored as numeric — Postgres holds them exactly. */
export async function ensureExposureHistoryTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    create table if not exists exposure_history (
      id bigint generated always as identity primary key,
      ts timestamptz not null default now(),
      -- Σ payoff × buyers across unsettled flights, asset base units
      total_liability_units numeric not null,
      total_managed_units numeric not null,
      -- liability the brake cannot scope (flight missing from routes file)
      unknown_liability_units numeric not null,
      open_policies integer not null,
      insured_flights integer not null,
      -- worst single bucket as a fraction of vault capacity (0..1+)
      worst_route_fraction double precision not null,
      worst_airport_fraction double precision not null
    )
  `;
  // Self-created tables default to RLS-DISABLED and Supabase grants the
  // public schema to anon/authenticated — enable deny-all RLS (zero
  // policies) like every migration-defined table. The owning server-side
  // role bypasses RLS. Idempotent.
  await sql`alter table exposure_history enable row level security`;
  await sql`create index if not exists exposure_history_ts_idx on exposure_history (ts desc)`;
}

/** Append one measured exposure read as a history row. */
export async function recordExposureHistory(row: {
  totalLiabilityUnits: bigint;
  totalManagedUnits: bigint;
  unknownLiabilityUnits: bigint;
  openPolicies: number;
  insuredFlights: number;
  worstRouteFraction: number;
  worstAirportFraction: number;
}): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const sql = getDb();
    await ensureExposureHistoryTable(sql);
    await sql`
      insert into exposure_history
        (total_liability_units, total_managed_units, unknown_liability_units,
         open_policies, insured_flights, worst_route_fraction, worst_airport_fraction)
      values
        (${row.totalLiabilityUnits.toString()}, ${row.totalManagedUnits.toString()},
         ${row.unknownLiabilityUnits.toString()}, ${row.openPolicies}, ${row.insuredFlights},
         ${row.worstRouteFraction}, ${row.worstAirportFraction})
    `;
  } catch (err) {
    console.warn(`[exposure-history] append failed (job unaffected): ${err}`);
  }
}
