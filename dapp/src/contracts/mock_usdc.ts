import * as Client from "mock_usdc"
import { rpcUrl, networkPassphrase } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: "CDYZY5QA77SCNRKS7AOSVLCRKGI7TKYCWNAIHMOAKTZ5FLS3SR5MAE5Z",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
