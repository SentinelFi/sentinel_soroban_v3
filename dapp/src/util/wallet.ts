import {
	type Networks,
	type SwkAppTheme,
	StellarWalletsKit,
} from "@creit.tech/stellar-wallets-kit"
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils"
import { Horizon } from "@stellar/stellar-sdk"
import { networkPassphrase, stellarNetwork } from "../contracts/util"
import storage from "./storage"

/**
 * Kit modal theme built from the app's own design tokens. The kit writes
 * these values as `--swk-*` custom properties on <html> — the same element
 * that carries `data-theme` and the token definitions — so every var()
 * resolves against the ACTIVE theme and the modal re-skins itself when the
 * user flips fun/serious, with no setTheme call needed.
 *
 * Vars that only exist in serious get fun's value as the fallback:
 * radius falls back to 0 (hard pixel edges), shadow to the hard step.
 */
const modalTheme: SwkAppTheme = {
	background: "var(--color-surface)",
	"background-secondary": "var(--color-inset)",
	"foreground-strong": "var(--color-ink)",
	foreground: "var(--color-dim)",
	"foreground-secondary": "var(--color-mute)",
	primary: "var(--color-gold)",
	"primary-foreground": "var(--color-page)",
	transparent: "transparent",
	lighter: "rgba(255, 255, 255, 0.06)",
	light: "rgba(255, 255, 255, 0.12)",
	"light-gray": "var(--color-dim)",
	gray: "var(--color-mute)",
	danger: "var(--color-loss)",
	border: "var(--color-line-mid)",
	shadow: "var(--shadow-soft-md, var(--shadow-px-md))",
	"border-radius": "var(--radius-ctl, 0px)",
	"font-family": "var(--font-body)",
}

StellarWalletsKit.init({
	network: networkPassphrase as Networks,
	// defaultModules → every zero-config wallet (Freighter, xBull, Lobstr,
	// Albedo, Hana, Rabet, …); the kit modal lists them all and offers an
	// install link for wallets the browser doesn't have.
	modules: defaultModules(),
	theme: modalTheme,
})

export const connectWallet = async () => {
	// `authModal` handles wallet selection and connection in one flow;
	// it rejects if the user closes the modal without connecting.
	let address: string
	try {
		;({ address } = await StellarWalletsKit.authModal())
	} catch {
		return
	}

	const selectedId = StellarWalletsKit.selectedModule.productId
	if (address) {
		storage.setItem("walletId", selectedId)
		storage.setItem("walletAddress", address)
	} else {
		storage.setItem("walletId", "")
		storage.setItem("walletAddress", "")
	}

	if (selectedId == "freighter" || selectedId == "hot-wallet") {
		void StellarWalletsKit.getNetwork()
			.then((network) => {
				if (network.network && network.networkPassphrase) {
					storage.setItem("walletNetwork", network.network)
					storage.setItem("networkPassphrase", network.networkPassphrase)
				} else {
					storage.setItem("walletNetwork", "")
					storage.setItem("networkPassphrase", "")
				}
			})
			.catch((err: unknown) => {
				// non-fatal: the provider's poll loop retries; an unhandled
				// rejection here would just spam the console/reporting
				console.error("getNetwork failed during connect:", err)
			})
	}
}

export const disconnectWallet = async () => {
	await StellarWalletsKit.disconnect()
	storage.removeItem("walletId")
}

function getHorizonHost(mode: string) {
	switch (mode) {
		case "LOCAL":
			return "http://localhost:8000"
		case "FUTURENET":
			return "https://horizon-futurenet.stellar.org"
		case "TESTNET":
			return "https://horizon-testnet.stellar.org"
		case "PUBLIC":
			return "https://horizon.stellar.org"
		default:
			throw new Error(`Unknown Stellar network: ${mode}`)
	}
}

const horizon = new Horizon.Server(getHorizonHost(stellarNetwork), {
	allowHttp: stellarNetwork === "LOCAL",
})

const formatter = new Intl.NumberFormat()

/** Horizon balance line plus a locale-formatted display string.
 *  `balance` keeps Horizon's raw numeric string so consumers can still
 *  parse it; `displayBalance` ("1,234.5") is for rendering only. */
export type WalletBalance = Horizon.HorizonApi.BalanceLine & {
	displayBalance: string
}

export type MappedBalances = Record<string, WalletBalance>

export const fetchBalances = async (address: string) => {
	try {
		const { balances } = await horizon.accounts().accountId(address).call()
		const mapped = balances.reduce((acc, b) => {
			const key =
				b.asset_type === "native"
					? "xlm"
					: b.asset_type === "liquidity_pool_shares"
						? b.liquidity_pool_id
						: `${b.asset_code}:${b.asset_issuer}`
			acc[key] = {
				...b,
				displayBalance: formatter.format(Number(b.balance)),
			}
			return acc
		}, {} as MappedBalances)
		return mapped
	} catch (err) {
		// `not found` is sort of expected, indicating an unfunded wallet, which
		// the consumer of `balances` can understand via the lack of `xlm` key.
		// If the error does NOT match 'not found', log the error.
		// We should also possibly not return `{}` in this case?
		if (!(err instanceof Error && err.message.match(/not found/i))) {
			console.error(err)
		}
		return {}
	}
}

export const wallet = StellarWalletsKit
