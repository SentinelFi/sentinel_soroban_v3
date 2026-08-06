import * as Client from "controller"
import { rpcUrl, networkPassphrase, allowHttpRpc } from "./util"
import { CONTRACT_IDS } from "./ids"

export default new Client.Client({
	networkPassphrase,
	contractId: CONTRACT_IDS.controller,
	rpcUrl,
	// Cleartext RPC only on a local network or to a loopback custom
	// endpoint (see allowHttpRpc in ./util.ts); a prod https RPC keeps
	// allowHttp false so a MITM cannot downgrade to http and feed forged
	// simulation results into what the wallet signs.
	allowHttp: allowHttpRpc,
	publicKey: undefined,
})
