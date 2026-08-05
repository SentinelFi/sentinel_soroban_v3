/**
 * IATA carrier prefix → airline name. Purely cosmetic (hover tooltips on
 * the board's route cells); covers the carriers present in the discovered
 * fleet plus a couple of common majors. Unknown prefixes get no tooltip.
 */
const AIRLINE_NAMES: Record<string, string> = {
	AA: "American Airlines",
	AS: "Alaska Airlines",
	B6: "JetBlue Airways",
	DL: "Delta Air Lines",
	F9: "Frontier Airlines",
	HA: "Hawaiian Airlines",
	NK: "Spirit Airlines",
	UA: "United Airlines",
	WN: "Southwest Airlines",
}

/**
 * ICAO airline prefix → IATA, for the carriers in the fleet.
 *
 * Fleet `flight_id`s are ICAO idents ("ASA462"), but airline names and
 * FlightRadar24 URLs are both keyed by IATA ("AS", "as462"). Slicing the
 * first two ICAO letters only works by coincidence (AAL→AA, UAL→UA); it
 * silently fails for DAL→"DA", JBU→"JB", FFT→"FF", SWA→"SW" — 279 of the
 * 1,069 seeded routes. This table is the real mapping.
 */
const ICAO_TO_IATA: Record<string, string> = {
	AAL: "AA",
	ASA: "AS",
	DAL: "DL",
	FFT: "F9",
	HAL: "HA",
	JBU: "B6",
	NKS: "NK",
	SWA: "WN",
	UAL: "UA",
}

/** Split an ICAO ident into its carrier prefix and numeric suffix. */
function splitIdent(flightId: string): { prefix: string; number: string } | null {
	const m = /^([A-Za-z]+)\s*0*(\d+)$/.exec(flightId.trim())
	return m ? { prefix: m[1]!.toUpperCase(), number: m[2]! } : null
}

/**
 * IATA carrier code for a flight id. Prefers an explicit carrier from the
 * catalog (always correct); falls back to the ICAO prefix table.
 */
export function iataCarrier(flightId: string, carrier?: string | null): string | undefined {
	if (carrier && carrier.trim()) return carrier.trim().toUpperCase()
	const parts = splitIdent(flightId)
	if (!parts) return undefined
	return ICAO_TO_IATA[parts.prefix] ?? (parts.prefix.length === 2 ? parts.prefix : undefined)
}

/** Airline name for a flight id ("ASA462" → "Alaska Airlines"), if known. */
export function airlineName(flightId: string, carrier?: string | null): string | undefined {
	const iata = iataCarrier(flightId, carrier)
	return iata ? AIRLINE_NAMES[iata] : undefined
}

/**
 * FlightRadar24 flight page slug. FR24 keys these by the IATA flight
 * number ("as462"), NOT the ICAO ident — passing "asa462" lands on their
 * "flight not found" page, which is why every board link was dead.
 * Returns null when the ident cannot be resolved, so callers can render
 * plain text instead of a broken link.
 */
export function flightradarSlug(flightId: string, carrier?: string | null): string | null {
	const parts = splitIdent(flightId)
	const iata = iataCarrier(flightId, carrier)
	if (!parts || !iata) return null
	return `${iata}${parts.number}`.toLowerCase()
}
