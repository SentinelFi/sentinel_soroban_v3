import * as Client from "risk_vault"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CDW5YUJXGJWPVOQBXYVDZN7P7QQSE3U6VGIHBN24HZKKCS5QQ75OLIJE",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
