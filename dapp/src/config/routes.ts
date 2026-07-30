/**
 * Candidate flight routes — sourced from the fleet file at build time.
 *
 * The phase-3 GovernanceModule intentionally has no on-chain route
 * enumeration (routes are keyed storage, queried per-route via
 * `route_status`). The frontend therefore keeps a candidate list here and
 * verifies each entry live: only routes whose `route_status` resolves to
 * `Active` are shown on the board, with terms taken from the chain — never
 * from this file.
 *
 * `config/routes.testnet.json` is the single human source of truth for
 * insurable routes (see its `$schema_note`) — the same file the seeding
 * pipeline, sale-auth, weather, and reprice jobs already read server-side
 * (`api/_lib/routes_config.ts`). Importing it here instead of hand-typing
 * a duplicate list means a newly whitelisted route shows up on the board
 * on the next deploy, with no second file to remember to update. Every
 * fleet entry is included regardless of its `enabled` flag — that flag
 * governs the sale-authorizer, not display; the live chain read is what
 * decides whether a route is actually shown.
 *
 * `useActiveRoutes` resolves these in chunks of 20 to stay friendly to the
 * public RPC, streaming results to the board as each chunk lands. The
 * board UI is search-first, so import order doesn't matter.
 *
 * Also exports `DEMO_ROUTES` — a random sample used when nothing has
 * resolved Active on-chain yet (see its own doc comment below).
 */

import routesConfig from "../../config/routes.testnet.json"

export interface CandidateRoute {
	flightId: string
	origin: string
	dest: string
}

interface FleetRouteEntry {
	flight_id: string
	origin: string
	destination: string
	enabled: boolean
}

const fleet = routesConfig as { routes: FleetRouteEntry[] }

export const CANDIDATE_ROUTES: CandidateRoute[] = fleet.routes.map((r) => ({
	flightId: r.flight_id,
	origin: r.origin,
	dest: r.destination,
}))

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
 * The board's DEMO/SAMPLE fallback when nothing has resolved Active
 * on-chain yet — a random sample of the fleet's whitelisted (`enabled`)
 * routes, picked once per page load. Prefers `enabled` routes since those
 * are the ones actually meant to be sellable; falls back to the full
 * fleet if every entry happens to be human-disabled, so a non-empty fleet
 * file still always has *some* demo data to show.
 */
export const DEMO_ROUTES: CandidateRoute[] = randomSample(
	(fleet.routes.filter((r) => r.enabled).length > 0
		? fleet.routes.filter((r) => r.enabled)
		: fleet.routes
	).map((r) => ({ flightId: r.flight_id, origin: r.origin, dest: r.destination })),
	DEMO_SAMPLE_SIZE,
)
