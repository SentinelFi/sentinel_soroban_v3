import * as Client from "mock_usdc"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CC6QGWZYDSQ6BQRAK3WKEIBPVRFNTKLCNKRMF6NNWLAWLMQU7LQKIXDH",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
