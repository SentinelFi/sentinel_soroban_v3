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

/** Airline name for a flight id ("AA100" → "American Airlines"), if known. */
export function airlineName(flightId: string): string | undefined {
	return AIRLINE_NAMES[flightId.slice(0, 2).toUpperCase()]
}
