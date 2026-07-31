import * as Client from "oracle_aggregator"
import { rpcUrl, networkPassphrase, stellarNetwork } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CDMKBMNJ2YZTARAM4ZUU7HZJZA7UUYJU76ZOAN2SCR3WJYZSSHXV7ESW",
	rpcUrl,
	// FSA-L02: only permit cleartext RPC on a local network; a prod https
	// RPC keeps allowHttp false so a MITM cannot downgrade to http and feed
	// forged simulation results into what the wallet signs.
	allowHttp: stellarNetwork === "LOCAL",
	publicKey: undefined,
})
