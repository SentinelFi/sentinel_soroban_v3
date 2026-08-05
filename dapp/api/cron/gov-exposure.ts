import { makeGovCronHandler } from "../_lib/governance/config.js";
import { run } from "../_lib/governance/exposure_collector.js";

/**
 * gov_exposure — hourly at :07, on its own minute so it never races the
 * revive engine (:40) for the gov-admin account sequence. Reads
 * authoritative on-chain state (no AeroAPI), mirrors InsuranceBought
 * events into `policies`, and opens `exposure` interventions — which DO
 * write the chain, through the audited GovSubmitter. This is also the only
 * caller that claims the disable cap.
 */
export default makeGovCronHandler(run);

export const config = { maxDuration: 300 };
