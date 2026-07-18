import { makeCronHandler } from "../_lib/handler";
import { run } from "../_lib/jobs/ttl";

export const config = { maxDuration: 300 };

export default makeCronHandler(run);
