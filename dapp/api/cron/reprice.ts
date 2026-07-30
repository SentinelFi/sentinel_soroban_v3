import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/jobs/repricer";

// Monthly ADVISORY seasonal repricing: stages a proposal in the
// pricing_runs DB table; never touches the chain or the fleet file. The
// admin applies via the manual ritual (price_routes → review →
// seed_routes --apply-terms).
export const config = { maxDuration: 300 };

export default makeGovCronHandler(run);
