import { stellarNetwork } from "../contracts/util"

/**
 * Stellar.expert explorer links, derived from the app's configured
 * network so a mainnet redeploy can't keep pointing at the testnet
 * explorer. Anything that isn't PUBLIC maps to testnet — the explorer
 * has no futurenet/local view, and a wrong-but-visible testnet link
 * beats a broken one.
 */
const EXPLORER_NETWORK = stellarNetwork === "PUBLIC" ? "public" : "testnet"

export function explorerTxUrl(hash: string): string {
	return `https://stellar.expert/explorer/${EXPLORER_NETWORK}/tx/${hash}`
}
