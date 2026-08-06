import { stellarNetwork } from "../contracts/util"
import { getExplorerKey, type ExplorerKey } from "./settings"

/**
 * Block-explorer links, derived from the app's configured network so a
 * mainnet redeploy can't keep pointing at the testnet explorer. Anything
 * that isn't PUBLIC maps to testnet — none of these explorers has a
 * futurenet/local view, and a wrong-but-visible testnet link beats a
 * broken one.
 *
 * Which explorer the links target is a user preference (Settings page,
 * Stellar Expert by default), read at call time so a change applies to
 * the next link rendered without a reload.
 */
const EXPLORER_NETWORK = stellarNetwork === "PUBLIC" ? "public" : "testnet"

const STELLARCHAIN_HOST =
	stellarNetwork === "PUBLIC"
		? "https://stellarchain.io"
		: "https://testnet.stellarchain.io"

const STEEXP_HOST =
	stellarNetwork === "PUBLIC"
		? "https://steexp.com"
		: "https://testnet.steexp.com"

export interface ExplorerDef {
	label: string
	txUrl: (hash: string) => string
	accountUrl: (address: string) => string
	contractUrl: (address: string) => string
}

export const EXPLORERS: Record<ExplorerKey, ExplorerDef> = {
	stellar_expert: {
		label: "StellarExpert",
		txUrl: (hash) =>
			`https://stellar.expert/explorer/${EXPLORER_NETWORK}/tx/${hash}`,
		accountUrl: (address) =>
			`https://stellar.expert/explorer/${EXPLORER_NETWORK}/account/${address}`,
		contractUrl: (address) =>
			`https://stellar.expert/explorer/${EXPLORER_NETWORK}/contract/${address}`,
	},
	stellarchain: {
		label: "StellarChain",
		txUrl: (hash) => `${STELLARCHAIN_HOST}/transactions/${hash}`,
		accountUrl: (address) => `${STELLARCHAIN_HOST}/accounts/${address}`,
		contractUrl: (address) => `${STELLARCHAIN_HOST}/contracts/${address}`,
	},
	steexp: {
		label: "Steexp",
		txUrl: (hash) => `${STEEXP_HOST}/tx/${hash}`,
		accountUrl: (address) => `${STEEXP_HOST}/account/${address}`,
		contractUrl: (address) => `${STEEXP_HOST}/contract/${address}`,
	},
}

/** Display name of the currently preferred explorer. */
export function explorerLabel(): string {
	return EXPLORERS[getExplorerKey()].label
}

export function explorerTxUrl(hash: string): string {
	return EXPLORERS[getExplorerKey()].txUrl(hash)
}

export function explorerAccountUrl(address: string): string {
	return EXPLORERS[getExplorerKey()].accountUrl(address)
}

export function explorerContractUrl(address: string): string {
	return EXPLORERS[getExplorerKey()].contractUrl(address)
}
