import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/governance/exposure_collector";

/**
 * gov_exposure — hourly at :07, before the reconciler (:10): each
 * reconcile tick sees fresh exposure. Reads authoritative on-chain state
 * (no AeroAPI); DB-only writes (facts), never the chain.
 */
export default makeGovCronHandler(run);

export const config = { maxDuration: 300 };
