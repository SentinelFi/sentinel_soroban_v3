import { getDb } from "./db";

/**
 * pricing_runs — the audit trail for ML route pricing, one row per run.
 *
 * Written by BOTH pricing contexts:
 *   - "manual:price_routes"  — step 2 of the admin intake pipeline
 *   - "cron:reprice"         — the monthly ADVISORY repricer (stages a
 *     proposal in this table; never touches the chain — the admin applies
 *     via the manual price → review → seed ritual)
 *
 * Strictly DB-optional: no GOVERNANCE_DB_URL → skipped with a console
 * note. The table self-creates on first write (the governance schema is
 * managed manually in Supabase; a one-row log table doesn't warrant a
 * migration ceremony).
 */

export interface PricingRunLog {
  context: "manual:price_routes" | "cron:reprice";
  model_version: string;
  priced_for_date: string; // YYYY-MM-DD
  total_candidates: number;
  priced: number;
  failed: number;
  /** Routes whose honest price exceeded the base cap — NOT whitelisted. */
  excluded: Array<{
    flight_id: string;
    origin: string;
    dest: string;
    p_covered: number;
    honest_premium_usdc: number;
  }>;
  /** Context-dependent summary: premium distribution, proposed changes, … */
  summary: import("postgres").JSONValue;
}

export async function logPricingRun(entry: PricingRunLog): Promise<boolean> {
  if (!process.env.GOVERNANCE_DB_URL) {
    console.log(`[pricing-log] GOVERNANCE_DB_URL not set — run not logged (${entry.context})`);
    return false;
  }
  try {
    const sql = getDb();
    await sql`
      create table if not exists pricing_runs (
        id bigint generated always as identity primary key,
        run_at timestamptz not null default now(),
        context text not null,
        model_version text not null,
        priced_for_date date not null,
        total_candidates int not null,
        priced int not null,
        failed int not null,
        excluded jsonb not null default '[]'::jsonb,
        summary jsonb not null default '{}'::jsonb
      )
    `;
    // FSA-H01: enable deny-all RLS on this self-created table (see the same
    // note in governance/interventions.ts). Without it the table is world
    // read/write via PostgREST using only the public key; the owning
    // postgres role bypasses RLS so server-side access is unaffected.
    await sql`alter table pricing_runs enable row level security`;
    await sql`
      insert into pricing_runs
        (context, model_version, priced_for_date, total_candidates, priced, failed, excluded, summary)
      values
        (${entry.context}, ${entry.model_version}, ${entry.priced_for_date},
         ${entry.total_candidates}, ${entry.priced}, ${entry.failed},
         ${sql.json(entry.excluded)}, ${sql.json(entry.summary)})
    `;
    console.log(`[pricing-log] run logged to pricing_runs (${entry.context})`);
    return true;
  } catch (err) {
    console.warn(`[pricing-log] failed to log run (ignored): ${err}`);
    return false;
  }
}
