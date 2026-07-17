/**
 * Candidate flight routes.
 *
 * The phase-3 GovernanceModule intentionally has no on-chain route
 * enumeration (routes are keyed storage, queried per-route via
 * `route_status`). The frontend therefore keeps a candidate list here and
 * verifies each entry live: only routes whose `route_status` resolves to
 * `Active` are shown to buyers, with terms taken from the chain — never
 * from this file.
 *
 * To list a new route in the UI: whitelist it on-chain from the Admin page,
 * then add it here.
 */

export interface CandidateRoute {
	flightId: string
	origin: string
	dest: string
}

export const CANDIDATE_ROUTES: CandidateRoute[] = [
	{ flightId: "AA100", origin: "JFK", dest: "LAX" },
	{ flightId: "UA200", origin: "SFO", dest: "ORD" },
	{ flightId: "DL300", origin: "ATL", dest: "MIA" },
]
