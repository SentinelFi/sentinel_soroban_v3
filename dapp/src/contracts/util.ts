/**
 * Network configuration from `PUBLIC_*` env vars (see .env).
 * Simplified from frontend/src/contracts/util.ts: plain env reads,
 * no zod / contract-explorer dependency.
 */

type StellarNetwork = "PUBLIC" | "FUTURENET" | "TESTNET" | "LOCAL"

const rawNetwork = (import.meta.env.PUBLIC_STELLAR_NETWORK as string) || "LOCAL"

export const stellarNetwork: StellarNetwork =
	rawNetwork === "STANDALONE" ? "LOCAL" : (rawNetwork as StellarNetwork)

export const networkPassphrase: string =
	(import.meta.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE as string) ||
	"Standalone Network ; February 2017"

// NOTE: needs to be exported for contract files in this directory
//
// Residual trust assumption (inherent to any single-RPC frontend): the
// displayed premiums/payoffs AND the simulation that assembles the tx
// the wallet signs both come from this one endpoint. A compromised RPC
// could show one number and simulate another; the user's real
// verification point is the wallet's own signing prompt. allowHttp is
// restricted to LOCAL in every client, so a network MITM downgrade is
// prevented — endpoint compromise is the remaining (accepted) risk.
export const rpcUrl: string =
	(import.meta.env.PUBLIC_STELLAR_RPC_URL as string) ||
	"http://localhost:8000/rpc"

export const horizonUrl: string =
	(import.meta.env.PUBLIC_STELLAR_HORIZON_URL as string) ||
	"http://localhost:8000"
