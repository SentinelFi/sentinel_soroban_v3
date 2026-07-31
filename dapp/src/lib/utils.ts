import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

/** "just now" / "37m ago" / "5h ago" / "3d ago" — cron-run recency. */
export function relTime(iso: string | null): string {
	if (!iso) return "never"
	const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
	if (mins < 1) return "just now"
	if (mins < 60) return `${mins}m ago`
	if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`
	return `${Math.floor(mins / 1440)}d ago`
}

export function formatDate(epoch: bigint): string {
	if (epoch === 0n) return "TBD"
	const d = new Date(Number(epoch) * 1000)
	return d.toISOString().slice(0, 10)
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
 * `AssembledTransaction.signAndSend()`. Used to attach a Stellar.expert
 * explorer link to success toasts. Returns undefined if not available.
 */
export function txHashOf(sent: unknown): string | undefined {
	const hash = (sent as { sendTransactionResponse?: { hash?: string } })
		?.sendTransactionResponse?.hash
	return typeof hash === "string" && hash.length > 0 ? hash : undefined
}
