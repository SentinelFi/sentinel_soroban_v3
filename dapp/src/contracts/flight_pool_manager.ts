import * as Client from "flight_pool_manager"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CD6XRCMKALQLB63ZYMA7GCW3Q2BQROGKYASRRRNZEFRPINQ6JFXO6YZT",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
