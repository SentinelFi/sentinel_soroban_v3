import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../_lib/governance/db";
import { JOB_REGISTRY, latestRuns } from "../_lib/governance/runs";
import { publicError } from "../_lib/public_error";

/**
 * GET /api/status/runs — PUBLIC job-health feed for the /status page.
 *
 * Deliberately sanitized: job identity, schedule, last run time,
 * duration, and pass/fail only. No error text, no action payloads, no
 * trigger attribution — those stay on the authenticated admin board.
 *
 * Also carries the settlement-barrier gauge (ops_flags 'barrier', written
 * best-effort by the settler): engaged + since + age, with `stalled: true`
 * once the age exceeds two settler cycles (10 min) — the protocol's single
 * most important operational alert condition (every LP entry/exit is
 * frozen while the barrier is up).
 */
const BARRIER_STALL_SECS = 600; // 2 settler cycles

async function readBarrier(): Promise<{
  engaged: boolean;
  since: string | null;
  age_secs: number | null;
  pending: number | null;
  stalled: boolean;
} | null> {
  try {
    const sql = getDb();
    const rows = (await sql`
      select value, data, updated_at from ops_flags where key = 'barrier'
    `) as unknown as Array<{ value: boolean; data: { since?: string; pending?: number } | null; updated_at: string }>;
    if (rows.length === 0) return { engaged: false, since: null, age_secs: null, pending: null, stalled: false };
    const r = rows[0];
    if (!r.value) return { engaged: false, since: null, age_secs: null, pending: null, stalled: false };
    const since = r.data?.since ?? null;
    const age = since ? Math.floor((Date.now() - Date.parse(since)) / 1000) : null;
    return {
      engaged: true,
      since,
      age_secs: age,
      pending: r.data?.pending ?? null,
      stalled: age !== null && age > BARRIER_STALL_SECS,
    };
  } catch {
    return null; // DB down — feed still serves job rows from the same DB… so this stays null anyway
  }
}
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
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
