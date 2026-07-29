import * as Client from "risk_vault"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
