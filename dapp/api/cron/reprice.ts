import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/jobs/repricer";

// Monthly seasonal repricing. Prices stay ADVISORY (proposal →
// pricing_runs; the admin applies via price_routes → review →
// seed_routes --apply-terms). Its one action: live routes priced above
// the base cap get a `pricing` intervention (pause), revived by the run
// that prices them back under.
export const config = { maxDuration: 300 };

export default makeGovCronHandler(run);
