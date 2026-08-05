import { errorMessage } from "./utils"
import { describeContractError } from "./contractErrors"

/**
 * Translate raw wallet/SDK/contract failures into human sentences for
 * the tx steppers and toasts. The raw string (HostError, XDR fragments,
 * simulation diagnostics) stays in the console — useTxFlow logs it
 * before calling this — so support can still see it; the UI shouldn't.
 * Patterns before length-trimming; first match wins.
 */
export function humanizeTxError(err: unknown, fallback = "Transaction failed"): string {
	const raw = errorMessage(err, fallback)

	// wallet-kit rejections: "User declined access", "Request was rejected", …
	if (/user\s+(decl|denied|reject)|declin|denied|rejected by user|cancell?ed by/i.test(raw)) {
		return "Signature request was declined in the wallet."
	}
	// Contract codes FIRST. A generic /insufficient/ sweep used to run ahead
	// of this and swallow the code — a failed token transfer inside a buy
	// reads "insufficient", and so the specific reason was replaced by a
	// vague one. The code is the most precise thing we have; never lose it.
	const contract = raw.match(/Error\(Contract, #(\d+)\)/)
	if (contract) {
		const code = Number(contract[1])
		const described = describeContractError(code)
		return described ?? `The contract rejected this transaction (error #${code}).`
	}
	if (/insufficient|underfunded|balance is not sufficient/i.test(raw)) {
		return "Your wallet doesn't have enough USDC for this transaction."
	}
	if (/txbadseq|bad_seq/i.test(raw)) {
		return "Transaction sequence error — wait a moment and try again."
	}
	if (/timeout|timed out/i.test(raw)) {
		return "The network timed out — the transaction may not have gone through. Check your balance before retrying."
	}
	// unknown failure: keep it, but never dump a full XDR/diagnostic blob
	return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw
}
