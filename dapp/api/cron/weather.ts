import { makeGovCronHandler } from "../_lib/governance/config.js";
import { run } from "../_lib/jobs/weather.js";

// Stateless storm surcharge loop (every ~2h): fleet-file base + flat
// surcharge from the live 3-day forecast, applied/cleared on-chain via
// the audited GovSubmitter. No DB, no signals. Replaced the route_agent
// signals collector + reconciler premium path (2026-07-30 simplification).
// 800s: the 1,069-route fleet sweep runs ~160s warm but scheduled (cold)
// runs were busting 300s — Fluid compute on Pro allows the headroom.
export const config = { maxDuration: 800 };

export default makeGovCronHandler(run);
