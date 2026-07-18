import { makeCronHandler } from "../_lib/handler";
import { run } from "../_lib/jobs/fetcher";

// AeroAPI round-trips + tx polling for every active flight — allow the
// full 5 minutes (requires a Vercel plan that permits maxDuration 300).
export const config = { maxDuration: 300 };

export default makeCronHandler(run);
