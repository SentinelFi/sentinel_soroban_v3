import * as Client from "risk_vault"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CAHUWF7GMAKZK34C3BBQWHA4GLAI2OSXGL25KMLW45INBDJMVQRAL3QW",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
