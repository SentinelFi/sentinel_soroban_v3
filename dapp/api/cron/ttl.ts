import { makeCronHandler } from "../_lib/handler.js";
import { run } from "../_lib/jobs/ttl.js";

export const config = { maxDuration: 300 };

export default makeCronHandler(run);
