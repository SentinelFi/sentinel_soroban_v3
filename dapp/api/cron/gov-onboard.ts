import { makeGovCronHandler } from "../_lib/governance/config.js";
import { run } from "../_lib/governance/onboard.js";

/**
 * gov_onboard — every 6 hours at :15. STATUS SYNC ONLY: upserts every
 * fleet-file route into the DB with its actual on-chain status, so the
 * governance layer can never be blind to a route the file whitelisted.
 * It writes no chain state. Route intake stays a manual, admin-gated
 * pipeline (scripts/: discover → price → review → seed); the old
 * candidate-ingest and GOV_ONBOARD_AUTO promotion phases were removed
 * 2026-07-29. See onboard.ts for the full rationale.
 */
export default makeGovCronHandler(run);

export const config = { maxDuration: 300 };
