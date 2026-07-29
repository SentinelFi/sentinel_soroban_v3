import * as Client from "controller"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CBDJIPZOC7KH3ICK57MAUZMUXBQ5XF56WJLRP2OY6FF5V2HOFDOFXVY3",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
