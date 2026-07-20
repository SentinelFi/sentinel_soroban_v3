import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "./config";
import { cronTrigger, recordRun } from "./governance/runs";
import type { Config, RunLogEntry } from "./types";

/**
 * Auth for cron endpoints.
 *
 * - If CRON_SECRET is configured, the caller MUST present
 *   `Authorization: Bearer <CRON_SECRET>`. Vercel's cron scheduler sends
 *   exactly that header automatically when a CRON_SECRET project env var
 *   exists, so scheduled invocations and manual curl both pass the same
 *   check — and a spoofed `x-vercel-cron` header alone is not enough.
 * - If CRON_SECRET is NOT configured, fall back to accepting requests
 *   carrying the `x-vercel-cron` header (set by Vercel's scheduler; the
 *   platform strips it from external requests). Anything else is 401.
 */
export function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    return req.headers.authorization === `Bearer ${secret}`;
  }
  return Boolean(req.headers["x-vercel-cron"]);
}

/**
 * Wrap a job's `run(config)` into a Vercel handler:
 * 1. auth (401 on failure)
 * 2. load config lazily — never at module import time, so importing a
 *    route file has no side effects and never throws on missing env
 * 3. run the job; 200 with the RunLogEntry on success, 500 with the
 *    entry (or error detail) on failure
 */
export function makeCronHandler(run: (config: Config) => Promise<RunLogEntry>) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let config: Config;
    try {
      config = loadConfig();
    } catch (err) {
      res.status(500).json({ error: `Config error: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    try {
      const entry = await run(config);
      await recordRun(entry, cronTrigger(req.headers));
      res.status(entry.success ? 200 : 500).json(entry);
    } catch (err) {
      // Jobs catch their own errors and return success:false; this is a
      // belt-and-braces net for anything that escapes.
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}
