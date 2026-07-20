import * as Client from "controller"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CCWDQVAJCNMU2P35JF5RNGC7PM2LGWBXBSO6QUME2PJFK5LTVFNQZGHB",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
