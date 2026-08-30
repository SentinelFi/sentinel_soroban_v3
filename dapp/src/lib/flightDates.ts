/**
 * Origin-local ("boarding-pass") date helpers for the UTC-keyed calendar.
 *
 * Policies are keyed on-chain by the UTC calendar date of the scheduled
 * departure. Boarding passes carry the LOCAL date at the origin, and ~19%
 * of the fleet departs late enough local evening that the two differ by a
 * day. The BetSlip uses these to show which boarding-pass date a picked
 * (UTC) date actually covers. Display-only: nothing prices, authorizes or
 * settles off anything computed here.
 */

const MIN_PER_DAY = 1440

/** Minutes east of UTC for an IANA zone at an instant; null if unresolvable. */
function tzOffsetMinutes(tz: string, at: Date): number | null {
	try {
		const name = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			timeZoneName: "shortOffset",
		})
			.formatToParts(at)
			.find((p) => p.type === "timeZoneName")?.value
		if (!name) return null
		if (name === "GMT" || name === "UTC") return 0
		const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name)
		if (!m) return null
		const sign = m[1] === "-" ? -1 : 1
		return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0))
	} catch {
		return null
	}
}

/** "2026-08-05" in `tz` for a unix-seconds epoch; null if the zone is unknown. */
export function zonedDate(epochSecs: number, tz: string): string | null {
	try {
		// en-CA renders YYYY-MM-DD directly.
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date(epochSecs * 1000))
	} catch {
		return null
	}
}

/** "17:30" for a local HHMM number (1730). */
export function hhmmStr(hhmm: number): string {
	const h = Math.floor(hhmm / 100) % 24
	const m = hhmm % 100
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/**
 * Boarding-pass (origin-local) departure date of the instance covered by
 * the UTC date-bucket `utcDateStr`, for a flight leaving at `depHhmm`
 * origin-local. The covered instance is the one whose departure falls on
 * that UTC date, so its local date is the UTC date minus however many
 * days the UTC clock has rolled past the local one at departure (and plus
 * one east of UTC before local midnight-equivalent). Null when the zone
 * can't be resolved; approximate only across a DST switch night.
 */
export function coveredLocalDate(
	utcDateStr: string,
	depHhmm: number,
	tz: string,
): string | null {
	const [y, mo, d] = utcDateStr.split("-").map(Number)
	if (!y || !mo || !d) return null
	const offset = tzOffsetMinutes(tz, new Date(Date.UTC(y, mo - 1, d, 12)))
	if (offset === null) return null
	const localMin = (Math.floor(depHhmm / 100) % 24) * 60 + (depHhmm % 100)
	const dayDelta = Math.floor((localMin - offset) / MIN_PER_DAY)
	return new Date(Date.UTC(y, mo - 1, d - dayDelta)).toISOString().slice(0, 10)
}
