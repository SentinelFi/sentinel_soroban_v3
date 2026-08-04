import { makeGovCronHandler } from "../_lib/governance/config.js";
import { run } from "../_lib/jobs/revive.js";

// Hourly: weather/exposure predicates are free-or-cheap re-checks; the
// cancellation sweeps (2 AeroAPI calls each) only fire on rows ~20h past
// their last check, ≤20 per run. Headroom for API retry/backoff paths.
export const config = { maxDuration: 300 };

export default makeGovCronHandler(run);
