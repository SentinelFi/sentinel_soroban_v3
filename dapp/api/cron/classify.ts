import { makeCronHandler } from "../_lib/handler.js";
import { run } from "../_lib/jobs/classifier.js";

export const config = { maxDuration: 300 };

export default makeCronHandler(run);
