import postgres from "postgres";

/**
 * Governance DB connection — Supabase Postgres over the Supavisor
 * TRANSACTION-mode pooler (port 6543). Serverless functions must go
 * through the pooler: direct connections would exhaust Postgres slots
 * under lambda fan-out, and the direct host is IPv6-only anyway.
 *
 * Transaction pooling constraints honored here:
 * - prepare: false (prepared statements don't survive pooled backends)
 * - max: 1 per lambda instance; concurrency comes from lambda scale-out
 *
 * GOVERNANCE_DB_URL example (password from Vercel env, never committed):
 *   postgresql://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
 */

let sql: ReturnType<typeof postgres> | null = null;

export function getDb(): ReturnType<typeof postgres> {
  if (!sql) {
    const url = process.env.GOVERNANCE_DB_URL;
    if (!url) throw new Error("Missing required env var: GOVERNANCE_DB_URL");
    sql = postgres(url, {
      prepare: false,
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sql;
}
