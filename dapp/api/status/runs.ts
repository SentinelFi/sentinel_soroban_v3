import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../_lib/governance/db.js";
import { allowRequest, clientIp } from "../_lib/rate_limit.js";
import { JOB_REGISTRY, latestRuns } from "../_lib/governance/runs.js";
import { publicError } from "../_lib/public_error.js";

/**
 * GET /api/status/runs — PUBLIC job-health feed for the /status page.
 *
 * Deliberately sanitized: job identity, schedule, last run time,
 * duration, and pass/fail only. No error text, no action payloads, no
 * trigger attribution — those stay on the authenticated admin board.
 *
 * Also carries the settlement-barrier gauge (ops_flags 'barrier', written
 * best-effort by the settler), COARSENED to two booleans (OCA-M06):
 * `engaged` (LP entry/exit currently frozen — users can see that on-chain
 * anyway) and `stalled` (age exceeds two settler cycles, 10 min — the
 * protocol's single most important operational alert condition). The
 * precise since/age/pending internals stay on the authenticated admin
 * surface: they would let an observer time purchases/withdrawals around
 * live settlement state.
 */
const BARRIER_STALL_SECS = 600; // 2 settler cycles

async function readBarrier(): Promise<{ engaged: boolean; stalled: boolean } | null> {
  try {
    const sql = getDb();
    const rows = (await sql`
      select value, data, updated_at from ops_flags where key = 'barrier'
    `) as unknown as Array<{ value: boolean; data: { since?: string; pending?: number } | null; updated_at: string }>;
    const row = rows[0];
    if (!row?.value) return { engaged: false, stalled: false };
    // since/pending are read to COMPUTE the stalled flag but never echoed.
    const since = row.data?.since ?? null;
    const age = since ? Math.floor((Date.now() - Date.parse(since)) / 1000) : null;
    return { engaged: true, stalled: age !== null && age > BARRIER_STALL_SECS };
  } catch {
    return null; // DB down — feed still serves job rows from the same DB… so this stays null anyway
  }
}
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!(await allowRequest("status-runs", clientIp(req), 20))) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "rate limit exceeded — retry in a minute" });
    return;
  }

  try {
    const latest = await latestRuns();
    const byJob = new Map(latest.map((r) => [r.job, r]));
    const jobs = JOB_REGISTRY.map((info) => {
      const last = byJob.get(info.job);
      return {
        job: info.job,
        description: info.description,
        schedule: info.schedule,
        last_run_at: last?.ran_at ?? null,
        duration_ms: last?.duration_ms ?? null,
        success: last?.success ?? null,
      };
    });
    const barrier = await readBarrier();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ jobs, barrier, as_of: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: publicError("status-runs", err) });
  }
}
