import * as Client from "oracle_aggregator"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CDMKBMNJ2YZTARAM4ZUU7HZJZA7UUYJU76ZOAN2SCR3WJYZSSHXV7ESW",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
