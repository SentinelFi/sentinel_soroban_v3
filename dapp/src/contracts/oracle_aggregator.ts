import * as Client from "oracle_aggregator"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CDOLYXPIV63FGRCIPOFZY5HNRS34QZHZJVEUUVJHSFEFW5H4CHQHJEYZ",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
