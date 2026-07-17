import * as Client from "controller"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CD7KCPQJFYSEUPJ43VXC6RIYCF4WPTVUHH3ANWNPYXTYGE2NBRXGFTXB",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
