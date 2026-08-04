import { makeCronHandler } from "../_lib/handler.js";
import { run } from "../_lib/jobs/queue.js";

export const config = { maxDuration: 300 };

export default makeCronHandler(run);
