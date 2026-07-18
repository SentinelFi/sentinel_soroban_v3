import * as Client from "flight_pool_manager"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CCEOYQREEASJ3F2EMNDJDP35ZXTMRVO3LKH3TGEZ6O2UDBCFVQNGDLWJ",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
