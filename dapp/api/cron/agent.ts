import { makeCronHandler } from "../_lib/handler";
import { run } from "../_lib/jobs/route_agent";

// Daily governance agent: ML pricing + weather rules + 24h re-evaluation
// of disabled routes.
export const config = { maxDuration: 300 };

export default makeCronHandler(run);
