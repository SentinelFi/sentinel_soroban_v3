/**
 * Admin companion to the daily revive cron — re-checks PAUSED routes
 * (paused by the route guard's cancellation sweep, ledger: route_health)
 * and re-enables any whose flight is verifiably back in the schedule.
 *
 * Same logic as the cron, different scope:
 *   - cron (daily, automatic): 20 most recently paused routes
 *   - this script:             the same 20 by default, or EVERYTHING
 *                              still paused with --all
 *
 * Run (from dapp/):
 *   npx tsx ../scripts/revive_routes.ts          # last 20 paused
 *   npx tsx ../scripts/revive_routes.ts --all    # every paused route
 *
 * Needs GOVERNANCE_DB_URL (the pause ledger), AEROAPI_KEY, and
 * GOVERNANCE_ADMIN_SECRET_KEY (falls back to the local
 * `sentinel-governor` stellar identity, same as seed_routes).
 */

import { execFileSync } from "child_process";
import { loadDotEnv } from "../dapp/scripts/env";
loadDotEnv();
import { loadGovConfig } from "../dapp/api/_lib/governance/config";
import { run } from "../dapp/api/_lib/jobs/revive";

function resolveGovKey(): void {
  if (process.env.GOVERNANCE_ADMIN_SECRET_KEY) return;
  try {
    const key = execFileSync("stellar", ["keys", "show", "sentinel-governor"], {
      encoding: "utf-8",
    }).trim();
    if (key) process.env.GOVERNANCE_ADMIN_SECRET_KEY = key;
  } catch {
    /* fall through — loadGovConfig reports the missing key */
  }
}

async function main(): Promise<void> {
  resolveGovKey();
  const all = process.argv.includes("--all");
  console.log(`Revive check — scope: ${all ? "ALL paused routes" : "20 most recently paused"}`);

  const entry = await run(loadGovConfig(), { limit: all ? "all" : 20 });
  for (const a of entry.actions ?? []) {
    console.log(`  ${a.flight}: ${a.transition ?? a.skipped ?? a.error}`);
  }
  console.log(entry.success ? "Done." : `FAILED: ${entry.error}`);
  process.exit(entry.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
