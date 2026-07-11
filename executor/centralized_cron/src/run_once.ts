/**
 * Run a single cron job once — for testing and debugging.
 *
 * Usage:
 *   npm run authorize # SaleAuthorizer
 *   npm run fetch     # FlightDataFetcher
 *   npm run classify  # FlightClassifier
 *   npm run settle    # SettlementExecutor
 *   npm run queue     # QueueMaintainer (audit M-03 split)
 *   npm run ttl       # TTLExtender + prune_settled
 */

import { loadConfig } from "./config.js";
import { runSaleAuthorizer } from "./sale_authorizer.js";
import { runFlightDataFetcher } from "./flight_data_fetcher.js";
import { runFlightClassifier } from "./flight_classifier.js";
import { runSettlementExecutor } from "./settlement_executor.js";
import { runQueueMaintainer } from "./queue_maintainer.js";
import { runTTLExtender } from "./ttl_extender.js";

const job = process.argv[2];
const config = loadConfig();

switch (job) {
  case "authorize":
    await runSaleAuthorizer(config);
    break;
  case "fetch":
    await runFlightDataFetcher(config);
    break;
  case "classify":
    await runFlightClassifier(config);
    break;
  case "settle":
    await runSettlementExecutor(config);
    break;
  case "queue":
    await runQueueMaintainer(config);
    break;
  case "ttl":
    await runTTLExtender(config);
    break;
  default:
    console.error(`Unknown job: ${job}. Use: authorize, fetch, classify, settle, queue, or ttl`);
    process.exit(1);
}
