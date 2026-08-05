import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../_lib/config.js";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { loadGovConfig } from "../_lib/governance/config.js";
import { JOB_REGISTRY, latestRuns, recentRuns, recordRun } from "../_lib/governance/runs.js";
import { run as runClassifier } from "../_lib/jobs/classifier.js";
import { run as runFetcher } from "../_lib/jobs/fetcher.js";
import { run as runQueue } from "../_lib/jobs/queue.js";
import { run as runRepricer } from "../_lib/jobs/repricer.js";
import { run as runRevive } from "../_lib/jobs/revive.js";
import { run as runSettler } from "../_lib/jobs/settler.js";
import { run as runTtl } from "../_lib/jobs/ttl.js";
import { run as runWeather } from "../_lib/jobs/weather.js";
import { run as runGovExposure } from "../_lib/governance/exposure_collector.js";
import { run as runGovOnboard } from "../_lib/governance/onboard.js";
import type { JobName, RunLogEntry } from "../_lib/types.js";

// Manual runs can be slow (fetcher walks every active flight).
export const config = { maxDuration: 300 };

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_SINCE_HOURS = 720; // 30 days
const DEFAULT_SINCE_HOURS = 24;

/**
 * Admin API — the JOBS board.
 *
 * GET  → registry + latest run per job + recent history
 *        (?limit=, default 50, max 200; ?since_hours=, default 24,
 *         max 720). `total` is the row count for the since_hours
 *         window, before limit.
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
  weather: () => runWeather(loadGovConfig()),
  reprice: () => runRepricer(loadGovConfig()),
  revive: () => runRevive(loadGovConfig()),
  gov_exposure: () => runGovExposure(loadGovConfig()),
  gov_onboard: () => runGovOnboard(loadGovConfig()),
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET") {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
      const sinceHours = Math.min(
        MAX_SINCE_HOURS,
        Math.max(1, Number(req.query.since_hours) || DEFAULT_SINCE_HOURS)
      );
      // latestRuns() is deliberately unwindowed — the public status feed
      // and the /api/status/alert uptime probe read the same helper and
      // need the last run per job however old it is.
      const [latest, page] = await Promise.all([latestRuns(), recentRuns(limit, sinceHours)]);
      res.status(200).json({
        registry: JOB_REGISTRY,
        latest,
        recent: page.rows,
        total: page.total,
        limit,
        since_hours: sinceHours,
      });
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
