import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

export function formatDate(epoch: bigint): string {
	if (epoch === 0n) return "TBD"
	const d = new Date(Number(epoch) * 1000)
	return d.toISOString().slice(0, 10)
}

/**
 * Pull the transaction hash out of the value returned by
 * `AssembledTransaction.signAndSend()`. Used to attach a Stellar.expert
 * explorer link to success toasts. Returns undefined if not available.
 */
export function txHashOf(sent: unknown): string | undefined {
	const hash = (sent as { sendTransactionResponse?: { hash?: string } })
		?.sendTransactionResponse?.hash
	return typeof hash === "string" && hash.length > 0 ? hash : undefined
}
