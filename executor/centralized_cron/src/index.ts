import cron from "node-cron";
import { loadConfig } from "./config.js";
import { tryRunExclusive } from "./job_lock.js";
import { runSaleAuthorizer } from "./sale_authorizer.js";
import { runFlightDataFetcher } from "./flight_data_fetcher.js";
import { runFlightClassifier } from "./flight_classifier.js";
import { runSettlementExecutor } from "./settlement_executor.js";
import { runQueueMaintainer } from "./queue_maintainer.js";
import { runTTLExtender } from "./ttl_extender.js";
import type { JobName, RunLogEntry } from "./types.js";
import { logRun } from "./run_log.js";
import { startServer } from "./server.js";

const config = loadConfig();

console.log("Sentinel Protocol — Centralized Cron Executor (Phase 3 contracts)");
console.log(`RPC: ${config.stellarRpcUrl}`);
console.log(`Oracle:           ${config.oracleAggregatorId.slice(0, 12)}...`);
console.log(`Controller:       ${config.controllerId.slice(0, 12)}...`);
console.log(`RiskVault:        ${config.riskVaultId.slice(0, 12)}...`);
console.log(`Governance:       ${config.governanceId.slice(0, 12)}...`);
console.log(`FlightPoolMgr:    ${config.flightPoolManagerId.slice(0, 12)}...`);
console.log(`AeroAPI:          ${config.aeroApiBaseUrl}`);
console.log("");

// Start HTTP API server
startServer(config);

// Cron scheduling. Cadences match spec/architecture.md.
//
// Two layers keep same-key jobs from racing one source account's sequence:
// the SorobanClient serializes every build/submit lifecycle per signer and
// retries sequence conflicts, and each job runs single-flight (a tick is
// skipped while the previous run of the same job is still in progress).
// The schedule offsets below remain as defense-in-depth so same-key jobs
// rarely contend in the first place.

function scheduleJob(
  expr: string,
  job: JobName,
  label: string,
  run: () => Promise<RunLogEntry>
): void {
  cron.schedule(expr, async () => {
    const entry = await tryRunExclusive(job, async () => {
      console.log(`\n[${new Date().toISOString()}] Running ${label}...`);
      return run();
    });
    if (entry === null) {
      console.warn(
        `[${new Date().toISOString()}] Skipping ${label} — previous run still in progress.`
      );
      return;
    }
    logRun(entry);
  });
}

// Cron #0 — SaleAuthorizer — oracle key — every 2 hours at :30.
// Shares the oracle key with the fetcher, so it runs off-tempo (:30 vs :00).
// Its cadence must stay comfortably inside SALE_AUTH_VALIDITY_SECS or every
// sale window lapses between runs.
scheduleJob("30 */2 * * *", "sale_authorizer", "SaleAuthorizer", () =>
  runSaleAuthorizer(config)
);

// Cron #1 — FlightDataFetcher — oracle key — every 2 hours at :00
scheduleJob("0 */2 * * *", "fetcher", "FlightDataFetcher", () =>
  runFlightDataFetcher(config)
);

// Cron #2 — FlightClassifier — keeper key — hourly at :01, off the shared
// :00 tick where the settler (same key) also fires.
scheduleJob("1 * * * *", "classifier", "FlightClassifier", () =>
  runFlightClassifier(config)
);

// Cron #3 — SettlementExecutor — keeper key — every 5 min at :00/:05/...
scheduleJob("*/5 * * * *", "settler", "SettlementExecutor", () =>
  runSettlementExecutor(config)
);

// Cron #3b — QueueMaintainer — keeper key — every 5 min, offset by 2 min
// from the settler's ticks.
scheduleJob("2-59/5 * * * *", "queue_maintainer", "QueueMaintainer", () =>
  runQueueMaintainer(config)
);

// Cron #4 — TTLExtender + prune — own key — daily at 00:00 UTC
scheduleJob("0 0 * * *", "ttl_extender", "TTLExtender", () =>
  runTTLExtender(config)
);

console.log("Cron jobs scheduled:");
console.log("  SaleAuthorizer:       every 2h at :30          (oracle key)");
console.log("  FlightDataFetcher:    every 2h at :00         (oracle key)");
console.log("  FlightClassifier:     hourly at :01            (keeper key)");
console.log("  SettlementExecutor:   every 5m at :00/:05/...  (keeper key)");
console.log("  QueueMaintainer:      every 5m at :02/:07/...  (keeper key)");
console.log("  TTLExtender + prune:  daily at 00:00 UTC       (own key)");
console.log("\nWaiting for next tick...");
