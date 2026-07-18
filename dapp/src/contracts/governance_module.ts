import * as Client from "governance_module"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CB4GWBXFQ2TVHJVDYA7OOB7KNNASWCNNPW7BZDPYOCJZOBAXWK3B57VL",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
