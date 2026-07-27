import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../_lib/config";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { loadGovConfig } from "../_lib/governance/config";
import { JOB_REGISTRY, latestRuns, recentRuns, recordRun } from "../_lib/governance/runs";
import { run as runAuthorizer } from "../_lib/jobs/authorizer";
import { run as runClassifier } from "../_lib/jobs/classifier";
import { run as runFetcher } from "../_lib/jobs/fetcher";
import { run as runQueue } from "../_lib/jobs/queue";
import { run as runRouteAgent } from "../_lib/jobs/route_agent";
import { run as runSettler } from "../_lib/jobs/settler";
import { run as runTtl } from "../_lib/jobs/ttl";
import { run as runGovReconcile } from "../_lib/governance/reconciler";
import { run as runGovSignals } from "../_lib/governance/signals_collector";
import { run as runGovExposure } from "../_lib/governance/exposure_collector";
import { run as runGovOnboard } from "../_lib/governance/onboard";
import type { JobName, RunLogEntry } from "../_lib/types";

// Manual runs can be slow (fetcher walks every active flight).
export const config = { maxDuration: 300 };

/**
 * Admin API — the JOBS board.
 *
 * GET  → registry + latest run per job + recent history (?limit=)
 * POST → { job } — run a job NOW, same code path as its cron, recorded
 *        in cron_runs with trigger 'manual:<email>'. Jobs are idempotent
 *        by design so a manual tick is always safe; per-invocation env
 *        (GOV_DRY_RUN etc.) still applies.
 */

const RUNNERS: Record<JobName, () => Promise<RunLogEntry>> = {
  fetcher: () => runFetcher(loadConfig()),
  classifier: () => runClassifier(loadConfig()),
  settler: () => runSettler(loadConfig()),
  queue_maintainer: () => runQueue(loadConfig()),
  ttl_extender: () => runTtl(loadConfig()),
  sale_authorizer: () => runAuthorizer(loadConfig()),
  route_agent: () => runRouteAgent(loadConfig()),
  gov_reconcile: () => runGovReconcile(loadGovConfig()),
  gov_signals: () => runGovSignals(loadGovConfig()),
  gov_exposure: () => runGovExposure(loadGovConfig()),
  gov_onboard: () => runGovOnboard(loadGovConfig()),
  // Phase 3/4 — registered here as they land.
  gov_schedule_check: () => Promise.reject(new Error("gov_schedule_check not implemented yet")),
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET") {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const [latest, recent] = await Promise.all([latestRuns(), recentRuns(limit)]);
      res.status(200).json({ registry: JOB_REGISTRY, latest, recent });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const job = req.body?.job as JobName | undefined;
    const info = JOB_REGISTRY.find((j) => j.job === job);
    if (!job || !info) {
      res.status(400).json({ error: `Unknown job: ${job}` });
      return;
    }
    if (!info.manualRunnable) {
      res.status(400).json({ error: `${job} is not manually runnable` });
      return;
    }

    const entry = await RUNNERS[job]();
    await recordRun(entry, `manual:${admin.email}`);
    res.status(entry.success ? 200 : 500).json(entry);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
