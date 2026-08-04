import type { JobName, RunLogEntry } from "../types.js";
import { getDb } from "./db.js";

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
  { job: "fetcher", path: "/api/cron/fetcher", schedule: "0 */2 * * *", intervalMinutes: 120, signer: "oracle", manualRunnable: true, description: "Settle sweep — insured flights past scheduled arrival + 5h: one AeroAPI call → outcome → targeted settle (promise: settled within 24h of ETA)" },
  { job: "revive", path: "/api/cron/revive", schedule: "40 * * * *", intervalMinutes: 60, signer: "gov-admin", manualRunnable: true, description: "Unified revive engine — re-checks every open intervention with its cause's own predicate (cancellation: daily sweep · exposure: eased 2 checks · weather: forecast cleared); last hold cleared → route re-enabled" },
  { job: "gov_exposure", path: "/api/cron/gov-exposure", schedule: "7 * * * *", intervalMinutes: 60, signer: "gov-admin", manualRunnable: true, description: "Exposure brake — on-chain liability concentration (route + airport) vs vault capacity; ≥50% → `exposure` intervention (pause, capped per run), ≥25% advisory. Also ingests the policies event mirror" },
  { job: "gov_onboard", path: "/api/cron/gov-onboard", schedule: "15 */6 * * *", intervalMinutes: 360, signer: "gov-admin", manualRunnable: true, description: "Fleet status sync — file/chain → DB (route INTAKE is the manual scripts/ pipeline, never automated)" },
  { job: "weather", path: "/api/cron/weather", schedule: "20 */2 * * *", intervalMinutes: 120, signer: "gov-admin", manualRunnable: true, description: "Storm surcharge — stateless: fleet-file base + flat forecast surcharge → update_route_terms (no DB)" },
  { job: "reprice", path: "/api/cron/reprice", schedule: "0 8 1 * *", intervalMinutes: 43200, signer: "gov-admin", manualRunnable: true, description: "Monthly seasonal repricing — prices stay ADVISORY (proposal → pricing_runs; admin applies via seed_routes --apply-terms) BUT live routes priced above the base cap get a `pricing` intervention (pause), revived when priced back under" },
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
