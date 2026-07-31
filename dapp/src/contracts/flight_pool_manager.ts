import * as Client from "flight_pool_manager"
import { rpcUrl, networkPassphrase, stellarNetwork } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7",
	rpcUrl,
	// FSA-L02: only permit cleartext RPC on a local network; a prod https
	// RPC keeps allowHttp false so a MITM cannot downgrade to http and feed
	// forged simulation results into what the wallet signs.
	allowHttp: stellarNetwork === "LOCAL",
	publicKey: undefined,
})
