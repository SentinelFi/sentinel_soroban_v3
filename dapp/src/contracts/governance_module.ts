import * as Client from "governance_module"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
