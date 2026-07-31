import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "./config";
import { cronTrigger, recordRun } from "./governance/runs";
import type { Config, RunLogEntry } from "./types";

/**
 * Auth for cron endpoints — CRON_SECRET is REQUIRED (fail closed).
 *
 * The caller MUST present `Authorization: Bearer <CRON_SECRET>`. Vercel's
 * cron scheduler sends exactly that header automatically whenever a
 * CRON_SECRET project env var exists, so scheduled invocations and manual
 * curl both pass the same check.
 *
 * When CRON_SECRET is unset, EVERY request is rejected. These endpoints
 * sign real transactions and spend keeper/oracle funds, so we never fall
 * back to trusting an unauthenticated request header: `x-vercel-cron` is
 * added by Vercel's scheduler but the platform's stripping of a spoofed
 * inbound copy is not a documented security guarantee, so it is not an
 * auth boundary. (cronTrigger still reads it, but only to LABEL a run as
 * scheduled vs external — never to authorize.)
 *
 * Deploy note: set CRON_SECRET in the Vercel project that runs the
 * scheduled crons (vercel.backend.json) BEFORE enabling them, or every
 * cron will 401. The bots runner (scripts/run_bot.ts) invokes each job's
 * run() directly and never passes through here, so it is unaffected.
 */
export function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  // OCA-L01: constant-time compare — this secret gates every keeper/
  // oracle/gov-admin-signed transaction; `===` short-circuits on the
  // first differing byte. (The length check leaks only the length,
  // which is standard and acceptable.)
  const expected = Buffer.from(`Bearer ${secret}`);
  const presented = Buffer.from(req.headers.authorization ?? "");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
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
