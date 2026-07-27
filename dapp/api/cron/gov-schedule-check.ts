import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/governance/schedule_check";

/**
 * gov_schedule_check — daily at 04:45 UTC (before the 06:00 route_agent).
 * Samples published schedules (authorizer-aligned cache keys → usually
 * zero extra API calls), fills canonical schedule/distance columns, and
 * emits schedule_drift signals (retimed → elevated, dropped → severe).
 */
export default makeGovCronHandler(run);

export const config = { maxDuration: 300 };
