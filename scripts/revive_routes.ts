/**
 * Admin companion to the hourly revive cron — force-runs the unified
 * revive engine over the ENTIRE interventions ledger, ignoring the
 * per-cause cadence gates (the cron re-sweeps cancellation rows ~daily
 * in batches of 20; this checks every open row NOW).
 *
 * Causes and their predicates (see dapp/api/_lib/jobs/revive.ts):
 *   cancellation → 5-day sweep finds a live day
 *   weather      → forecast no longer extreme
 *   exposure     → concentration eased (2-check hysteresis still applies)
 *   pricing      → owned by the monthly reprice run (reported only)
 *   admin        → never auto-revived (close via the /admin console)
 *
 * Run (from dapp/):
 *   npx tsx ../scripts/revive_routes.ts
 *
 * Needs GOVERNANCE_DB_URL (the ledger), AEROAPI_KEY, and
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
  console.log("Revive check — ALL open interventions, cadence gates bypassed.");

  const entry = await run(loadGovConfig(), { forceAll: true });
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
