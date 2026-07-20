import * as Client from "governance_module"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CANSHOFUFZPLZPCVUQYL3LBO25FW5BP6AEVAMNN2QS2BINGDIVZVEWYZ",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
