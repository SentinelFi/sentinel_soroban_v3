import * as Client from "oracle_aggregator"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CBSX3KRT4JI7XAOB33OTGZMZVOFXOS2LWDQCQKR2UAGHRMWYMC2D6QUL",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
