import { makeCronHandler } from "../_lib/handler";
import { run } from "../_lib/jobs/settler";

export const config = { maxDuration: 300 };

export default makeCronHandler(run);
