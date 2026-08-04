import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk"
import { networkPassphrase as appNetworkPassphrase } from "../contracts/util"

/**
 * E2E test-mode signer — the soak harness's hook into the real UI write
 * paths (spec/soak_test_plan.md). Playwright seeds `localStorage.e2eSecret`
 * per actor context; every wallet interaction then signs locally with that
 * keypair instead of opening a wallet extension.
 *
 * PROD-INERT BY CONSTRUCTION, three independent gates:
 *  1. `PUBLIC_E2E_SIGNER === "1"` — statically false in Vercel builds, so
 *     the whole branch is dead-code-eliminated from the prod bundle;
 *  2. `localStorage.e2eSecret` must hold a valid ed25519 secret seed;
 *  3. the app must be built for TESTNET — a mainnet build refuses even
 *     with the flag on.
 */

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"

export interface E2eSigner {
	address: string
	/** Reported passphrase — overridable via `localStorage.e2eNetworkPassphrase`
	 *  so the harness can deliberately trip the network-mismatch banner. */
	networkPassphrase: string
	signTransaction: (
		xdr: string,
		opts?: { networkPassphrase?: string; address?: string },
	) => Promise<{ signedTxXdr: string; signerAddress?: string }>
}

export function getE2eSigner(): E2eSigner | null {
	if (import.meta.env.PUBLIC_E2E_SIGNER !== "1") return null
	if (appNetworkPassphrase !== TESTNET_PASSPHRASE) return null
	let keypair: Keypair
	try {
		const secret = window.localStorage.getItem("e2eSecret")
		if (!secret) return null
		keypair = Keypair.fromSecret(secret)
	} catch {
		return null
	}
	const reportedPassphrase =
		window.localStorage.getItem("e2eNetworkPassphrase") ?? TESTNET_PASSPHRASE
	return {
		address: keypair.publicKey(),
		networkPassphrase: reportedPassphrase,
		signTransaction: (xdr, opts) => {
			// Always sign for the app's real network — the reported passphrase
			// above only feeds the mismatch banner, never the signature.
			const tx = TransactionBuilder.fromXDR(
				xdr,
				opts?.networkPassphrase ?? appNetworkPassphrase,
			)
			tx.sign(keypair)
			return Promise.resolve({
				signedTxXdr: tx.toXDR(),
				signerAddress: keypair.publicKey(),
			})
		},
	}
}
