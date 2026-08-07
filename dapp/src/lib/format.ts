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

/**
 * Convert a human USDC string to i128 units. Pure decimal-string
 * parsing — the amount the user signs must be EXACTLY what they typed,
 * so no binary-float detour ("0.29" via parseFloat is 2899999.99…
 * stroops, one short). Strict format: digits with an optional decimal
 * point ("12", "12.5", ".5"). Anything else — junk suffixes ("12.3abc"),
 * scientific notation ("1e3"), negatives — returns 0n, which the
 * callers' `<= 0n` guards treat as "no valid amount entered".
 * Fractions beyond 7 decimals are truncated (chain precision).
 */
export function parseUsdc(amount: string): bigint {
	const m = amount.trim().match(/^(\d+)?(?:\.(\d+))?$/)
	if (!m || (!m[1] && !m[2])) return 0n
	const whole = m[1] ?? "0"
	const frac = (m[2] ?? "")
		.slice(0, USDC_DECIMALS)
		.padEnd(USDC_DECIMALS, "0")
	return BigInt(whole) * USDC_DIVISOR + BigInt(frac || "0")
}

/**
 * Exact input-field string for a unit amount ("1234.567", no grouping,
 * trailing zeros trimmed) — used by MAX buttons so the round-trip
 * through parseUsdc reproduces the balance to the last unit.
 */
export function unitsToInput(units: bigint): string {
	if (units <= 0n) return "0"
	const whole = units / USDC_DIVISOR
	const frac = (units % USDC_DIVISOR)
		.toString()
		.padStart(USDC_DECIMALS, "0")
		.replace(/0+$/, "")
	return frac ? `${whole}.${frac}` : whole.toString()
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

/** "14:35" — UTC hh:mm for a unix-seconds epoch (scheduled departures). */
export function utcHm(epochSecs: number): string {
	return new Date(epochSecs * 1000).toISOString().slice(11, 16)
}

/* ── viewer-local rendering ────────────────────────────────────────────
 * The chain, the API and the cron pipeline speak UTC end to end, and that
 * stays — consistency there is what makes settlement reproducible. But a
 * traveler reading their own policies wants the clock on their wall, so
 * anything derived from a REAL INSTANT renders in the viewer's zone.
 *
 * A flight DATE BUCKET (the u64 UTC-midnight key the contract stores) is a
 * calendar label, not an instant: localizing it would shift the flight a day
 * backwards for every viewer west of UTC. Those keep using formatDate.
 */

const pad = (n: number): string => String(n).padStart(2, "0")

/** "PDT" / "GMT+2" — the viewer's zone abbreviation, "" if unavailable. */
function tzAbbr(d: Date): string {
	try {
		return (
			new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
				.formatToParts(d)
				.find((p) => p.type === "timeZoneName")?.value ?? ""
		)
	} catch {
		return ""
	}
}

/** "18:30 PDT" — local hh:mm + zone for a unix-seconds epoch. */
export function localHm(epochSecs: number): string {
	const d = new Date(epochSecs * 1000)
	const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
	const z = tzAbbr(d)
	return z ? `${hm} ${z}` : hm
}

/** "2026-08-06" — local calendar date for a unix-seconds epoch. */
export function localDate(epochSecs: number): string {
	const d = new Date(epochSecs * 1000)
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "01 Aug 2026 09:02" (withSeconds: "01 Aug 2026 09:02:47") in UTC. */
export function utcDateTime(iso: string, withSeconds = false): string {
	return new Date(iso).toUTCString().slice(5, withSeconds ? 25 : 22)
}

/** "2026-08-01 09:02" — compact sortable UTC stamp for log tables. */
export function isoMinute(iso: string): string {
	return new Date(iso).toISOString().slice(0, 16).replace("T", " ")
}
