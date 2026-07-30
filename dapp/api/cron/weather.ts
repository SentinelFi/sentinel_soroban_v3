import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/jobs/weather";

// Stateless storm surcharge loop (every ~2h): fleet-file base + flat
// surcharge from the live 3-day forecast, applied/cleared on-chain via
// the audited GovSubmitter. No DB, no signals. Replaced the route_agent
// signals collector + reconciler premium path (2026-07-30 simplification).
export const config = { maxDuration: 300 };

export default makeGovCronHandler(run);
