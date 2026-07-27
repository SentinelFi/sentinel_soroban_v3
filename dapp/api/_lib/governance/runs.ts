import type { JobName, RunLogEntry } from "../types";
import { getDb } from "./db";

/**
 * Cron run history — the ops layer behind the /admin JOBS board and the
 * public /status page.
 *
 * Every cron handler records its RunLogEntry here (best-effort: a DB
 * blip must never fail a job that already did its on-chain work), and
 * the JOB_REGISTRY below is the single source of truth for what jobs
 * exist, how often they should run, and whether an admin may trigger
 * them by hand.
 */

export interface JobInfo {
  job: JobName;
  path: string;
  /** Human schedule, mirrors dapp/vercel.json. */
  schedule: string;
  /** Expected minutes between runs — staleness = 2× this with no run. */
  intervalMinutes: number;
  /** Which signing identity the job uses (display only). */
  signer: "oracle" | "keeper" | "ttl" | "gov-admin" | "none";
  /** Safe to trigger from the admin board (all jobs are idempotent). */
  manualRunnable: boolean;
  description: string;
}

// Order = display order on the boards. Schedules mirror vercel.json —
// update BOTH when a cron changes.
export const JOB_REGISTRY: JobInfo[] = [
  { job: "settler", path: "/api/cron/settle", schedule: "*/5 * * * *", intervalMinutes: 5, signer: "keeper", manualRunnable: true, description: "Execute due settlements" },
  { job: "queue_maintainer", path: "/api/cron/queue", schedule: "2-59/5 * * * *", intervalMinutes: 5, signer: "keeper", manualRunnable: true, description: "Vault withdrawal-queue maintenance" },
  { job: "classifier", path: "/api/cron/classify", schedule: "0 * * * *", intervalMinutes: 60, signer: "keeper", manualRunnable: true, description: "Classify flights for settlement" },
  { job: "fetcher", path: "/api/cron/fetcher", schedule: "0 */2 * * *", intervalMinutes: 120, signer: "oracle", manualRunnable: true, description: "AeroAPI flight status → oracle" },
  { job: "sale_authorizer", path: "/api/cron/authorize", schedule: "30 */2 * * *", intervalMinutes: 120, signer: "oracle", manualRunnable: true, description: "Sale-window attestations" },
  { job: "gov_signals", path: "/api/cron/gov-signals", schedule: "5 * * * *", intervalMinutes: 60, signer: "none", manualRunnable: true, description: "Airport-delay collector — AeroAPI /airports/delays → signals (facts only, no chain writes)" },
  { job: "gov_reconcile", path: "/api/cron/gov-reconcile", schedule: "10 * * * *", intervalMinutes: 60, signer: "gov-admin", manualRunnable: true, description: "Governance reconciler — signals → on-chain" },
  { job: "route_agent", path: "/api/cron/agent", schedule: "0 6 * * *", intervalMinutes: 1440, signer: "gov-admin", manualRunnable: true, description: "Legacy daily route agent (ML + weather)" },
  { job: "ttl_extender", path: "/api/cron/ttl", schedule: "0 0 * * *", intervalMinutes: 1440, signer: "ttl", manualRunnable: true, description: "Extend contract TTLs, prune settled" },
];

/**
 * Persist a run — swallows all failures (console only). Jobs must keep
 * returning their entry to the HTTP caller even when history is down,
 * and the non-gov crons may run in deployments with no DB configured.
 */
export async function recordRun(entry: RunLogEntry, trigger: string): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const sql = getDb();
    await sql`
      insert into cron_runs (job, trigger, ran_at, duration_ms, success, error, actions)
      values (${entry.job}, ${trigger}, ${entry.timestamp}, ${entry.duration_ms},
              ${entry.success}, ${entry.error ?? null},
              ${entry.actions ? sql.json(entry.actions as any) : null})
    `;
  } catch (err) {
    console.error(`[cron-runs] failed to record ${entry.job} run: ${err}`);
  }
}

/** Trigger label for a cron endpoint invocation. */
export function cronTrigger(headers: Record<string, unknown>): string {
  return headers["x-vercel-cron"] ? "schedule" : "external";
}

export interface LastRun {
  job: string;
  trigger: string;
  ran_at: string;
  duration_ms: number;
  success: boolean;
  error: string | null;
  actions: unknown;
}

/** Latest run per job (one row each). */
export async function latestRuns(): Promise<LastRun[]> {
  const sql = getDb();
  return (await sql`
    select distinct on (job) job, trigger, ran_at, duration_ms, success, error, actions
    from cron_runs
    order by job, ran_at desc
  `) as unknown as LastRun[];
}

/** Recent run history, newest first. */
export async function recentRuns(limit: number): Promise<LastRun[]> {
  const sql = getDb();
  return (await sql`
    select job, trigger, ran_at, duration_ms, success, error, actions
    from cron_runs
    order by ran_at desc
    limit ${limit}
  `) as unknown as LastRun[];
}
