import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/jobs/route_agent";

// Daily ML pricing + forecast COLLECTOR (absorbed into the reconciler
// 2026-07-27): writes pricing/weather signals — facts only, no chain
// writes. The reconciler (hourly) applies them within its rails.
export const config = { maxDuration: 300 };

export default makeGovCronHandler(run);
