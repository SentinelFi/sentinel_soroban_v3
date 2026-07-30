import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/jobs/revive";

// ≤20 paused routes × (2 AeroAPI calls + possibly an enable tx) — quick,
// but leave headroom for the API's retry/backoff paths.
export const config = { maxDuration: 300 };

export default makeGovCronHandler(run);
