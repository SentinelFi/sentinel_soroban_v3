import { makeCronHandler } from "../_lib/handler";
import { run } from "../_lib/jobs/authorizer";

// AeroAPI round-trips for |enabled flights| x horizon days, plus tx
// submissions — allow the full window.
export const config = { maxDuration: 300 };

export default makeCronHandler(run);
