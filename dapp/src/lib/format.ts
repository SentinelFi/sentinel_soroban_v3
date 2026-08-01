/**
 * The one formatting module: USDC amounts, dates, and relative time.
 * Every page imports from here (directly or via the useContracts
 * re-exports) so display rules can't drift between pages.
 */

export const USDC_DECIMALS = 7
export const USDC_DIVISOR = 10_000_000n

/** Format i128 USDC amount to human-readable string ("1,234.56"). */
export function formatUsdc(amount: bigint): string {
	const negative = amount < 0n
	const abs = negative ? -amount : amount
	const whole = abs / USDC_DIVISOR
	const frac = abs % USDC_DIVISOR
	const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").slice(0, 2)
	return `${negative ? "-" : ""}${whole.toLocaleString()}.${fracStr}`
}

/** Convert human USDC string to i128. */
export function parseUsdc(amount: string): bigint {
	const num = parseFloat(amount)
	if (isNaN(num) || num <= 0) return 0n
	return BigInt(Math.floor(num * 10_000_000))
}

/**
 * Dollar display for a raw 7-decimal unit string (admin API rows).
 * bigint all the way down — no Number(units)/1e7 precision loss.
 */
export function usdFromUnits(units: string | null | undefined): string {
	if (units == null) return "—"
	try {
		return `$${formatUsdc(BigInt(units))}`
	} catch {
		return "—"
	}
}

/** "just now" / "37m ago" / "5h ago" / "3d ago". Accepts an ISO string
 *  (cron rows) or an epoch-ms number (activity log entries). */
export function relTime(at: string | number | null): string {
	if (at == null) return "never"
	const ms = typeof at === "number" ? at : new Date(at).getTime()
	const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000))
	if (secs < 60) return secs < 5 ? "just now" : `${secs}s ago`
	const mins = Math.floor(secs / 60)
	if (mins < 60) return `${mins}m ago`
	if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`
	return `${Math.floor(mins / 1440)}d ago`
}

/** "TBD" or YYYY-MM-DD for a unix-seconds epoch (u64 from chain). */
export function formatDate(epoch: bigint): string {
	if (epoch === 0n) return "TBD"
	const d = new Date(Number(epoch) * 1000)
	return d.toISOString().slice(0, 10)
}

/** "01 Aug 2026 09:02" (withSeconds: "01 Aug 2026 09:02:47") in UTC. */
export function utcDateTime(iso: string, withSeconds = false): string {
	return new Date(iso).toUTCString().slice(5, withSeconds ? 25 : 22)
}

/** "2026-08-01 09:02" — compact sortable UTC stamp for log tables. */
export function isoMinute(iso: string): string {
	return new Date(iso).toISOString().slice(0, 16).replace("T", " ")
}
