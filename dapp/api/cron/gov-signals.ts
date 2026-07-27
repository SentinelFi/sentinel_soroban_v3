import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/governance/signals_collector";

/**
 * gov_signals — hourly at :05, five minutes BEFORE the reconciler (:10) so
 * every reconcile tick acts on a fresh airport-delay picture. One AeroAPI
 * call per run; DB-only writes (facts), never the chain.
 */
export default makeGovCronHandler(run);

export const config = { maxDuration: 300 };
