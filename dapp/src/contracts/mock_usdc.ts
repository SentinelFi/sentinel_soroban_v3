import * as Client from "mock_usdc"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CCGB4TFBJYG7FMMZYH4BZC5SJITQIJ33XTJHSKRAVFKOQKDBM4QJPTVB",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
