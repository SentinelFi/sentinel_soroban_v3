import { makeCronHandler } from "../_lib/handler";
import { run } from "../_lib/jobs/classifier";

export const config = { maxDuration: 300 };

export default makeCronHandler(run);
