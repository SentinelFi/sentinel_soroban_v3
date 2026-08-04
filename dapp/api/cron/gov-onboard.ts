import { makeGovCronHandler } from "../_lib/governance/config.js";
import { run } from "../_lib/governance/onboard.js";

/**
 * gov_onboard — every 6 hours at :15. Syncs file/on-chain routes into the
 * DB (closing the reconciler's invisibility gap), ingests route-discovery
 * output as candidates, and — only with GOV_ONBOARD_AUTO=true — promotes
 * candidates on-chain through the audited GovSubmitter under per-run caps.
 */
export default makeGovCronHandler(run);

export const config = { maxDuration: 300 };
