import type { VercelRequest, VercelResponse } from "@vercel/node";
import { JOB_REGISTRY, latestRuns } from "../_lib/governance/runs";

/**
 * GET /api/status/runs — PUBLIC job-health feed for the /status page.
 *
 * Deliberately sanitized: job identity, schedule, last run time,
 * duration, and pass/fail only. No error text, no action payloads, no
 * trigger attribution — those stay on the authenticated admin board.
 */
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
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ jobs, as_of: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
