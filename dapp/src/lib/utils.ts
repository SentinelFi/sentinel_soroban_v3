import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

/**
 * Human-readable message from a caught value. Wallet kits reject with
 * plain `{ code, message }` objects rather than Error instances, so a
 * bare String(err) renders "[object Object]" in the UI.
 */
export function errorMessage(err: unknown, fallback = "Transaction failed"): string {
	if (err instanceof Error) return err.message
	if (typeof err === "string" && err.length > 0) return err
	if (
		typeof err === "object" &&
		err !== null &&
		"message" in err &&
		typeof (err as { message: unknown }).message === "string"
	) {
		return (err as { message: string }).message
	}
	return fallback
}

/**
 * Pull the transaction hash out of the value returned by
 * `AssembledTransaction.signAndSend()`. Used to attach a block-explorer
 * link to success toasts. Returns undefined if not available.
 */
export function txHashOf(sent: unknown): string | undefined {
	const hash = (sent as { sendTransactionResponse?: { hash?: string } })
		?.sendTransactionResponse?.hash
	return typeof hash === "string" && hash.length > 0 ? hash : undefined
}
