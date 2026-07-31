/**
 * Candidate flight routes — what the Markets board verifies on-chain.
 *
 * The phase-3 GovernanceModule intentionally has no on-chain route
 * enumeration (routes are keyed storage, queried per-route via
 * `route_status`), so the frontend keeps a candidate list and verifies
 * each entry live: only routes whose `route_status` resolves to `Active`
 * are shown, with terms taken from the chain — never from a file.
 *
 * Every verification is one RPC simulate-call PER ROUTE PER VISITOR, so
 * the candidate list must stay small even when the seeded fleet is large
 * (the fleet file holds every seeded route — hundreds after a full
 * harvest). Selection order:
 *
 *   1. `config/routes.live.json` — the admin-curated subset meant for the
 *      board. Non-empty → scan exactly these.
 *   2. Fleet fallback (`config/routes.testnet.json`, enabled entries,
 *      capped at MAX_FLEET_SCAN) — so a freshly seeded deployment shows
 *      something before the live list is curated.
 *
 * Also exports `DEMO_ROUTES` — sample rows for when nothing resolves
 * Active on-chain (see its own doc comment below).
 */

import routesConfig from "../../config/routes.testnet.json"
import liveConfig from "../../config/routes.live.json"

export interface CandidateRoute {
	flightId: string
	origin: string
	dest: string
}

interface FleetRouteEntry {
	flight_id: string
	origin: string
	destination: string
	enabled?: boolean
}

const fleet = routesConfig as { routes: FleetRouteEntry[] }
const live = liveConfig as { routes: FleetRouteEntry[] }

/** Fleet-fallback scan budget when no live list is curated yet. */
const MAX_FLEET_SCAN = 6

const toCandidate = (r: FleetRouteEntry): CandidateRoute => ({
	flightId: r.flight_id,
	origin: r.origin,
	dest: r.destination,
})

export const CANDIDATE_ROUTES: CandidateRoute[] =
	live.routes.length > 0
		? live.routes.map(toCandidate)
		: fleet.routes
				.filter((r) => r.enabled !== false)
				.slice(0, MAX_FLEET_SCAN)
				.map(toCandidate)

function randomSample<T>(items: T[], n: number): T[] {
	const shuffled = [...items]
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
	}
	return shuffled.slice(0, n)
}

const DEMO_SAMPLE_SIZE = 14

/**
 * Built-in sample rows — the demo board's last resort when both config
 * files are empty (fresh deployment, nothing seeded). Real-looking major
 * routes; never shown as purchasable (demo rows render with the DEMO
 * badge and no live terms).
 */
const STATIC_DEMO_ROUTES: CandidateRoute[] = [
	{ flightId: "AA100", origin: "JFK", dest: "LAX" },
	{ flightId: "UA456", origin: "EWR", dest: "SFO" },
	{ flightId: "DL789", origin: "ATL", dest: "BOS" },
	{ flightId: "AA1277", origin: "BOS", dest: "LAX" },
	{ flightId: "UA2402", origin: "ORD", dest: "DEN" },
	{ flightId: "DL2954", origin: "SEA", dest: "JFK" },
	{ flightId: "AA2662", origin: "DFW", dest: "MIA" },
	{ flightId: "UA1194", origin: "IAH", dest: "LAS" },
	{ flightId: "DL1856", origin: "MSP", dest: "PHX" },
	{ flightId: "AA544", origin: "CLT", dest: "SAN" },
]

/**
 * The board's DEMO/SAMPLE fallback when nothing has resolved Active
 * on-chain yet — a random sample of the fleet's whitelisted (`enabled`)
 * routes, picked once per page load. Prefers `enabled` routes since those
 * are the ones actually meant to be sellable; falls back to the full
 * fleet, and finally to the built-in static sample so the demo board is
 * never empty on a clean-slate deployment.
 */
const enabledFleet = fleet.routes.filter((r) => r.enabled !== false)
const demoPool = (
	enabledFleet.length > 0 ? enabledFleet : fleet.routes
).map(toCandidate)

export const DEMO_ROUTES: CandidateRoute[] = randomSample(
	demoPool.length > 0 ? demoPool : STATIC_DEMO_ROUTES,
	DEMO_SAMPLE_SIZE,
)
