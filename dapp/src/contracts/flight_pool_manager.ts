import * as Client from "flight_pool_manager"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
