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
export const rpcUrl: string =
	(import.meta.env.PUBLIC_STELLAR_RPC_URL as string) ||
	"http://localhost:8000/rpc"

export const horizonUrl: string =
	(import.meta.env.PUBLIC_STELLAR_HORIZON_URL as string) ||
	"http://localhost:8000"
