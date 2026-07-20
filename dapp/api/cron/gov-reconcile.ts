import { makeGovCronHandler } from "../_lib/governance/config";
import { run } from "../_lib/governance/reconciler";

export const config = { maxDuration: 300 };

export default makeGovCronHandler(run);
