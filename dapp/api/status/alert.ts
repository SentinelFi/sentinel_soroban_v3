import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../_lib/governance/db.js";
import { JOB_REGISTRY, latestRuns } from "../_lib/governance/runs.js";
import { publicError } from "../_lib/public_error.js";

/**
 * GET /api/status/alert — uptime-monitor probe. HTTP 200 when every
 * pipeline signal is healthy, HTTP 503 with a compact problem list when
 * anything needs a human. Point UptimeRobot / cron-job.org at this URL
 * and alert on non-200 — that closes the "everything is pull-based" gap
 * that let four import-crashed crons run dark for 2h on 2026-08-04.
 *
 * Alert conditions:
 *  - last recorded run of any job FAILED;
 *  - job stale: no run within 2× its cadence (JOB_REGISTRY rule, same
 *    as the admin board's gold lamp);
 *  - job has NEVER recorded a run even though the system has been alive
 *    for 2× its cadence (newest run across all jobs is the liveness
 *    proxy) — catches import-crash-class failures that die before the
 *    run recorder, which plain staleness never sees;
 *  - settlement barrier stalled (engaged longer than two settler
 *    cycles) — the single most important ops condition;
 *  - the DB itself unreachable (the feed everything above reads from).
 *
 * Sanitized like /api/status/runs: job names and conditions only, no
 * error text. Never cached — monitors need the live answer.
 */
const BARRIER_STALL_SECS = 600;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");

  const problems: string[] = [];
  try {
    const latest = await latestRuns();
    const byJob = new Map(latest.map((r) => [r.job, r]));
    const now = Date.now();
    const runTimes = latest.map((r) => Date.parse(String(r.ran_at))).filter((t) => Number.isFinite(t));
    const newestRunMs = runTimes.length ? Math.max(...runTimes) : 0;
    const oldestRunMs = runTimes.length ? Math.min(...runTimes) : 0;

    for (const info of JOB_REGISTRY) {
      const last = byJob.get(info.job);
      const staleAfterMs = 2 * info.intervalMinutes * 60_000;
      if (!last) {
        // Never recorded a run. Flag only when the system is observably
        // alive NOW (some job ran within 30min) and has been recording
        // for at least 2× this job's cadence (oldest recorded run) — so
        // a monthly job never false-alarms, but an import-crashed hourly
        // job that dies before the run recorder gets caught.
        const aliveNow = newestRunMs > 0 && now - newestRunMs < 30 * 60_000;
        const observedLongEnough = oldestRunMs > 0 && now - oldestRunMs > staleAfterMs;
        if (aliveNow && observedLongEnough) {
          problems.push(`${info.job}: never recorded a run (2x cadence elapsed)`);
        }
        continue;
      }
      if (last.success === false) {
        problems.push(`${info.job}: last run failed`);
        continue;
      }
      const age = now - Date.parse(String(last.ran_at));
      if (age > staleAfterMs) {
        problems.push(`${info.job}: stale (${Math.round(age / 60_000)}min since last run, cadence ${info.intervalMinutes}min)`);
      }
    }

    // Settlement barrier — engaged past two settler cycles = stalled.
    const sql = getDb();
    const rows = (await sql`
      select value, data from ops_flags where key = 'barrier'
    `) as unknown as Array<{ value: boolean; data: { since?: string } | null }>;
    const barrier = rows[0];
    if (barrier?.value) {
      const since = barrier.data?.since;
      const age = since ? Math.floor((Date.now() - Date.parse(since)) / 1000) : null;
      if (age !== null && age > BARRIER_STALL_SECS) problems.push(`settlement barrier: STALLED (${age}s)`);
    }
  } catch (err) {
    problems.push(`status feed unreachable: ${publicError("status-alert", err)}`);
  }

  res.status(problems.length === 0 ? 200 : 503).json({
    ok: problems.length === 0,
    problems,
    as_of: new Date().toISOString(),
  });
}
