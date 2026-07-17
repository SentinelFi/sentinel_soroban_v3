import cron from "node-cron";
import { loadConfig } from "./config.js";
import { runSaleAuthorizer } from "./sale_authorizer.js";
import { runFlightDataFetcher } from "./flight_data_fetcher.js";
import { runFlightClassifier } from "./flight_classifier.js";
import { runSettlementExecutor } from "./settlement_executor.js";
import { runQueueMaintainer } from "./queue_maintainer.js";
import { runTTLExtender } from "./ttl_extender.js";
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
// Settler + QueueMaintainer share the keeper key — schedule them off-tempo
// (settler at :00/:05/..., queue at :02/:07/...) to minimise sequence-number
// contention when both fire close to each other.

// Cron #0 — SaleAuthorizer — oracle key — every 2 hours at :30.
// Shares the oracle key with the fetcher, so it runs off-tempo (:30 vs :00)
// to avoid sequence-number contention. Its cadence must stay comfortably
// inside SALE_AUTH_VALIDITY_SECS or every sale window lapses between runs.
cron.schedule("30 */2 * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running SaleAuthorizer...`);
  const entry = await runSaleAuthorizer(config);
  logRun(entry);
});

// Cron #1 — FlightDataFetcher — oracle key — every 2 hours at :00
cron.schedule("0 */2 * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running FlightDataFetcher...`);
  const entry = await runFlightDataFetcher(config);
  logRun(entry);
});

// Cron #2 — FlightClassifier — keeper key — every hour at :00
cron.schedule("0 * * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running FlightClassifier...`);
  const entry = await runFlightClassifier(config);
  logRun(entry);
});

// Cron #3 — SettlementExecutor — keeper key — every 5 min at :00/:05/...
cron.schedule("*/5 * * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running SettlementExecutor...`);
  const entry = await runSettlementExecutor(config);
  logRun(entry);
});

// Cron #3b — QueueMaintainer — keeper key — every 5 min, offset by 2 min
// to avoid clashing with the settler's sequence number.
cron.schedule("2-59/5 * * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running QueueMaintainer...`);
  const entry = await runQueueMaintainer(config);
  logRun(entry);
});

// Cron #4 — TTLExtender + prune — own key — daily at 00:00 UTC
cron.schedule("0 0 * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running TTLExtender...`);
  const entry = await runTTLExtender(config);
  logRun(entry);
});

console.log("Cron jobs scheduled:");
console.log("  SaleAuthorizer:       every 2h at :30          (oracle key)");
console.log("  FlightDataFetcher:    every 2h at :00         (oracle key)");
console.log("  FlightClassifier:     hourly at :00            (keeper key)");
console.log("  SettlementExecutor:   every 5m at :00/:05/...  (keeper key)");
console.log("  QueueMaintainer:      every 5m at :02/:07/...  (keeper key)");
console.log("  TTLExtender + prune:  daily at 00:00 UTC       (own key)");
console.log("\nWaiting for next tick...");
