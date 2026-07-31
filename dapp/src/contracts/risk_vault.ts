import * as Client from "risk_vault"
import { rpcUrl, networkPassphrase, stellarNetwork } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF",
	rpcUrl,
	// FSA-L02: only permit cleartext RPC on a local network; a prod https
	// RPC keeps allowHttp false so a MITM cannot downgrade to http and feed
	// forged simulation results into what the wallet signs.
	allowHttp: stellarNetwork === "LOCAL",
	publicKey: undefined,
})
