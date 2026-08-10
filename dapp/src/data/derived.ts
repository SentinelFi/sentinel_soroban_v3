/**
 * Derived selectors — thin, deterministic transforms layered on top of the
 * contract hooks in `useContracts`. Anything synthesized here is an ESTIMATE
 * or ILLUSTRATIVE series (labelled as such in the UI), NOT precise on-chain
 * truth. The one exception is `airportCoords`, which is real geographic data.
 *
 * Honesty rule (see conventions): anything synthesized must be labelled, and
 * nothing invents a number that could be mistaken for a measurement. The
 * illustrative TVL/APY sparkline series are gone entirely. Every ANALYTICS
 * series on the House page (headline APR/APY, share-price chart) now reads
 * the `vault_history` DB mirror, never the chain: on-chain snapshots expire
 * after 30 days and cost one RPC round trip per day rendered. Live SPOT
 * values (TVL, free, locked) still read the chain — that is current truth,
 * not analytics. The only synthesized series left is the chart's
 * empty-state fallback, which the UI labels.
 *
 * `routeRisk` is NO LONGER in that category: it reports the real ML
 * probability the catalog carries, and returns "no data" when it has none,
 * rather than hashing the flight id into a plausible-looking percentage.
 */

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useActiveFlights, useFlightDataBatch } from "../hooks/useContracts"
import { DEMO_ROUTES, FLEET_ROUTES } from "../config/routes"

/* ── deterministic hashing ─────────────────────────────────────────── */

/** Small, stable string hash (FNV-1a-ish) → unsigned 32-bit int. */
function hashStr(s: string): number {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}

/** Deterministic PRNG (mulberry32) seeded from a 32-bit int. */
function seededRng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/* ── route delay risk ──────────────────────────────────────────────── */

export type RiskBand = "low" | "med" | "high" | "unknown"

export interface RouteRisk {
	/** Probability of the covered event, as a percent. Null = no data. */
	delayedPct: number | null
	band: RiskBand
	/** True when this is NOT a model probability (static table, or absent). */
	estimated: boolean
	/** p_covered / network baseline. Only set for real model values. */
	vsBaseline?: number
}

/**
 * A small static table of representative US-route on-time behaviour. Values
 * are illustrative baselines (delayed %), loosely reflecting that congested
 * hubs run worse. Averages out near ~20% delayed (≈80% on-time), matching the
 * US-domestic figure quoted elsewhere in the app.
 *
 * NOTE: this is an ESTIMATE, not measured history. Any flight not in the table
 * falls back to a hashed pseudo-risk so every row still gets a stable value.
 */
const ROUTE_DELAY_TABLE: Record<string, number> = {
	// origin-dest → delayed %
	"JFK-LAX": 24,
	"LAX-JFK": 23,
	"SFO-ORD": 31,
	"ORD-SFO": 29,
	"ATL-MIA": 16,
	"MIA-ATL": 15,
	"EWR-ORD": 34,
	"ORD-EWR": 33,
	"LGA-ORD": 30,
	"BOS-DCA": 22,
	"SEA-SFO": 19,
	"DEN-LAX": 18,
	"PHX-LAS": 12,
	"DFW-IAH": 17,
	"CLT-ATL": 21,
}

/**
 * Network-average rate of the covered event (arrival ≥3h late, cancelled or
 * diverted), measured over 24 months of BTS data. Mirrors
 * BASELINE_COVERED_RATE in agent/app/main.py — the model service grades its
 * own risk bands against this, and so do we, so the two never disagree.
 */
export const BASELINE_COVERED_RATE = 0.0342

/**
 * Delay risk for a route.
 *
 * When the catalog carries a real `p_covered` from the ML model, that is
 * what we show, banded RELATIVE TO the network baseline exactly as the
 * model service does (<0.75x low, <2x moderate, else high). The absolute
 * numbers are small — real p_covered spans ~0.4%-15% — so an absolute
 * threshold like "40% is red" would paint the entire fleet green and tell
 * the user nothing. Relative banding is what carries the signal.
 *
 * With no probability, we return `estimated: true` and a coarse figure from
 * the static table, or nothing at all. We deliberately do NOT hash the
 * flight id into a plausible-looking percentage any more: that produced
 * confident red numbers up to 44% — roughly triple anything physically
 * possible on this fleet — for routes nobody had measured.
 */
export function routeRisk(
	_flightId: string,
	route?: string,
	pCovered?: number | null,
): RouteRisk {
	if (typeof pCovered === "number" && pCovered >= 0) {
		const vs = pCovered / BASELINE_COVERED_RATE
		return {
			delayedPct: Math.round(pCovered * 1000) / 10, // one decimal: 1.4%
			band: vs < 0.75 ? "low" : vs < 2 ? "med" : "high",
			estimated: false,
			vsBaseline: Math.round(vs * 100) / 100,
		}
	}
	const key = route?.toUpperCase()
	const table = key ? ROUTE_DELAY_TABLE[key] : undefined
	if (table === undefined) return { delayedPct: null, band: "unknown", estimated: true }
	return {
		delayedPct: table,
		band: table >= 40 ? "high" : table >= 25 ? "med" : "low",
		estimated: true,
	}
}



interface VaultHistoryRow {
	ts: string
	total_assets: string
	share_price: string
}

/**
 * REAL vault time series (hourly buckets, 14 days) from the
 * vault_history mirror via the public status API. Empty until the
 * queue_maintainer cron has appended history — callers fall back to the
 * illustrative series and label it.
 */
function useVaultHistoryRows(hours = 336) {
	return useQuery({
		queryKey: ["derived", "vaultHistory", hours],
		queryFn: async (): Promise<VaultHistoryRow[]> => {
			const res = await fetch(`/api/status/vault-history?hours=${hours}`)
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			const body = (await res.json()) as { rows?: VaultHistoryRow[] }
			return body.rows ?? []
		},
		// the series gains at most one point per HOUR (hourly buckets), so
		// anything fresher than ~30min is wasted fetching; gcTime keeps the
		// cache alive across navigation away from the House page
		staleTime: 1_800_000,
		gcTime: 3_600_000,
		retry: 1,
	})
}

/**
 * Share-price series for the HEADLINE annualization, from the vault_history
 * mirror in ONE http call.
 *
 * Deliberately not on-chain `get_snapshot_price`: those entries carry a
 * 30-day TTL, so RPC physically cannot answer a 90-day window, and asking
 * it for 90 days costs 90 round trips to have most of them return zero.
 *
 * `day` is a FRACTIONAL day index (ms ÷ 86 400 000) rather than a whole
 * bucket, so a sub-day span still annualizes correctly instead of dividing
 * by a rounded-to-zero denominator.
 *
 * Caveat worth knowing at the call site: the mirror only reaches back to
 * the first queue_maintainer run that wrote it. Until it is older than the
 * window, this measures the mirror's lifetime, not the window asked for.
 */
export function useHeadlineSharePrice(days: number): {
	points: Array<{ day: number; price: number }>
	loading: boolean
} {
	const history = useVaultHistoryRows(days * 24)
	const points = (history.data ?? [])
		.map((r) => ({
			day: Date.parse(r.ts) / 86_400_000,
			price: Number(r.share_price) / SHARE_PRICE_SCALE,
		}))
		.filter((p) => Number.isFinite(p.day) && p.price > 0)
	return { points, loading: history.isPending }
}

/* ── share-price series (from the DB mirror; REAL where available) ─── */

export interface SharePricePoint {
	day: number
	price: number
}

export interface SharePriceSeries {
	points: SharePricePoint[]
	/** true when the series is synthesized (no recorded history yet). */
	illustrative: boolean
}

const SHARE_PRICE_SCALE = 10_000_000 // USDC 7-decimals

/**
 * Share-price series for the chart, from the `vault_history` mirror.
 *
 * Was `get_snapshot_price(day)` per day over RPC. Moved to the DB because
 * on-chain is the wrong home for ANALYTICS: snapshot entries live in
 * Temporary storage with a 30-day TTL, so history silently evaporates; the
 * series cost one RPC round trip per day rendered; and a single corrupt
 * snapshot (the 2026-08-06 offset bug, recorded 1000x low) is stuck in
 * chain state forever, where it bent this chart into a false crash.
 *
 * The mirror computes share price from total-managed-assets and supply on
 * every queue run, so it never carried that bug, is hourly rather than
 * daily, and is retained indefinitely. Live SPOT values (TVL, free, locked)
 * still read the chain — that is current truth, not analytics.
 *
 * Falls back to a short synthesized series flagged `illustrative: true`, so
 * a deployment with no recorded history yet still renders something the UI
 * labels honestly.
 */
export function useSharePriceSeries(days = 14): {
	data: SharePriceSeries | undefined
} {
	const history = useVaultHistoryRows(days * 24)
	const data = useMemo<SharePriceSeries | undefined>(() => {
		if (history.isPending) return undefined
		const points: SharePricePoint[] = (history.data ?? [])
			.map((r) => ({
				// FRACTIONAL epoch-day: the mirror is hourly, so a whole-day
				// index would collapse 24 samples onto one x position.
				day: Date.parse(r.ts) / 86_400_000,
				price: Number(r.share_price) / SHARE_PRICE_SCALE,
			}))
			.filter((p) => Number.isFinite(p.day) && p.price > 0)
		if (points.length >= 2) return { points, illustrative: false }

		// No recorded history — synthesize a short gently-rising series so the
		// chart is never empty. Flagged illustrative; UI must label it.
		const today = Math.floor(Date.now() / 1000 / 86_400)
		const rng = seededRng(hashStr("sharePrice"))
		const synth: SharePricePoint[] = Array.from({ length: days }, (_, i) => ({
			day: today - (days - 1 - i),
			price: Math.round((1 + i * 0.004 + (rng() - 0.5) * 0.003) * 1e4) / 1e4,
		}))
		return { points: synth, illustrative: true }
	}, [history.data, history.isPending, days])
	return { data }
}

/* ── airport coordinates (REAL data — used by the globe in wave 2) ──── */

export interface AirportCoord {
	lat: number
	lon: number
	name: string
}

/** ~50 US IATA airports → real lat/lon. Legit geographic data. */
export const airportCoords: Record<string, AirportCoord> = {
	ATL: { lat: 33.6407, lon: -84.4277, name: "Atlanta" },
	LAX: { lat: 33.9416, lon: -118.4085, name: "Los Angeles" },
	ORD: { lat: 41.9742, lon: -87.9073, name: "Chicago O'Hare" },
	DFW: { lat: 32.8998, lon: -97.0403, name: "Dallas–Fort Worth" },
	DEN: { lat: 39.8561, lon: -104.6737, name: "Denver" },
	JFK: { lat: 40.6413, lon: -73.7781, name: "New York JFK" },
	SFO: { lat: 37.6213, lon: -122.379, name: "San Francisco" },
	SEA: { lat: 47.4502, lon: -122.3088, name: "Seattle–Tacoma" },
	LAS: { lat: 36.084, lon: -115.1537, name: "Las Vegas" },
	MCO: { lat: 28.4312, lon: -81.3081, name: "Orlando" },
	MIA: { lat: 25.7959, lon: -80.287, name: "Miami" },
	CLT: { lat: 35.214, lon: -80.9431, name: "Charlotte" },
	EWR: { lat: 40.6895, lon: -74.1745, name: "Newark" },
	PHX: { lat: 33.4342, lon: -112.0116, name: "Phoenix" },
	IAH: { lat: 29.9902, lon: -95.3368, name: "Houston Intercontinental" },
	BOS: { lat: 42.3656, lon: -71.0096, name: "Boston Logan" },
	MSP: { lat: 44.8848, lon: -93.2223, name: "Minneapolis–St. Paul" },
	FLL: { lat: 26.0742, lon: -80.1506, name: "Fort Lauderdale" },
	DTW: { lat: 42.2162, lon: -83.3554, name: "Detroit" },
	PHL: { lat: 39.8744, lon: -75.2424, name: "Philadelphia" },
	LGA: { lat: 40.7769, lon: -73.874, name: "New York LaGuardia" },
	BWI: { lat: 39.1774, lon: -76.6684, name: "Baltimore–Washington" },
	SLC: { lat: 40.7899, lon: -111.9791, name: "Salt Lake City" },
	DCA: { lat: 38.8512, lon: -77.0402, name: "Washington Reagan" },
	IAD: { lat: 38.9531, lon: -77.4565, name: "Washington Dulles" },
	SAN: { lat: 32.7338, lon: -117.1933, name: "San Diego" },
	TPA: { lat: 27.9755, lon: -82.5332, name: "Tampa" },
	PDX: { lat: 45.5898, lon: -122.5951, name: "Portland" },
	HNL: { lat: 21.3187, lon: -157.9225, name: "Honolulu" },
	AUS: { lat: 30.1975, lon: -97.6664, name: "Austin" },
	BNA: { lat: 36.1263, lon: -86.6774, name: "Nashville" },
	MDW: { lat: 41.7868, lon: -87.7522, name: "Chicago Midway" },
	HOU: { lat: 29.6454, lon: -95.2789, name: "Houston Hobby" },
	DAL: { lat: 32.8471, lon: -96.8518, name: "Dallas Love" },
	OAK: { lat: 37.7126, lon: -122.2197, name: "Oakland" },
	SMF: { lat: 38.6954, lon: -121.5908, name: "Sacramento" },
	SJC: { lat: 37.3626, lon: -121.929, name: "San Jose" },
	MSY: { lat: 29.9934, lon: -90.258, name: "New Orleans" },
	RDU: { lat: 35.8801, lon: -78.7875, name: "Raleigh–Durham" },
	STL: { lat: 38.7487, lon: -90.37, name: "St. Louis" },
	CLE: { lat: 41.4117, lon: -81.8498, name: "Cleveland" },
	PIT: { lat: 40.4915, lon: -80.2329, name: "Pittsburgh" },
	CVG: { lat: 39.0489, lon: -84.6678, name: "Cincinnati" },
	IND: { lat: 39.7173, lon: -86.2944, name: "Indianapolis" },
	CMH: { lat: 39.998, lon: -82.8919, name: "Columbus" },
	MKE: { lat: 42.9472, lon: -87.8966, name: "Milwaukee" },
	SAT: { lat: 29.5337, lon: -98.4698, name: "San Antonio" },
	ABQ: { lat: 35.0402, lon: -106.6092, name: "Albuquerque" },
	OKC: { lat: 35.3931, lon: -97.6007, name: "Oklahoma City" },
	JAX: { lat: 30.4941, lon: -81.6879, name: "Jacksonville" },
	RSW: { lat: 26.5362, lon: -81.7552, name: "Fort Myers" },
	ANC: { lat: 61.1744, lon: -149.9964, name: "Anchorage" },
	// International hubs — real coords. Shown as quiet landmark dots so the
	// globe reads as a world map even where no route is approved yet.
	YYZ: { lat: 43.6777, lon: -79.6248, name: "Toronto" },
	MEX: { lat: 19.4363, lon: -99.0721, name: "Mexico City" },
	GRU: { lat: -23.4356, lon: -46.4731, name: "São Paulo" },
	BOG: { lat: 4.7016, lon: -74.1469, name: "Bogotá" },
	EZE: { lat: -34.8222, lon: -58.5358, name: "Buenos Aires" },
	LHR: { lat: 51.47, lon: -0.4543, name: "London Heathrow" },
	CDG: { lat: 49.0097, lon: 2.5479, name: "Paris CDG" },
	AMS: { lat: 52.3105, lon: 4.7683, name: "Amsterdam" },
	FRA: { lat: 50.0379, lon: 8.5622, name: "Frankfurt" },
	MAD: { lat: 40.4983, lon: -3.5676, name: "Madrid" },
	IST: { lat: 41.2753, lon: 28.7519, name: "Istanbul" },
	DXB: { lat: 25.2532, lon: 55.3657, name: "Dubai" },
	DOH: { lat: 25.2731, lon: 51.6081, name: "Doha" },
	JNB: { lat: -26.1367, lon: 28.2411, name: "Johannesburg" },
	DEL: { lat: 28.5562, lon: 77.1, name: "Delhi" },
	BOM: { lat: 19.0896, lon: 72.8656, name: "Mumbai" },
	SIN: { lat: 1.3644, lon: 103.9915, name: "Singapore" },
	HKG: { lat: 22.308, lon: 113.9185, name: "Hong Kong" },
	PVG: { lat: 31.1443, lon: 121.8083, name: "Shanghai" },
	NRT: { lat: 35.772, lon: 140.3929, name: "Tokyo Narita" },
	ICN: { lat: 37.4602, lon: 126.4407, name: "Seoul" },
	SYD: { lat: -33.9399, lon: 151.1753, name: "Sydney" },
}

/**
 * Major international hubs, always drawn as quiet landmark dots (with a light
 * label) so the globe reads as a real world airport map, independent of which
 * routes are approved. Codes must exist in `airportCoords`.
 */
export const INTL_HUBS = [
	"YYZ", "MEX", "GRU", "BOG", "EZE", "LHR", "CDG", "AMS", "FRA", "MAD",
	"IST", "DXB", "DOH", "JNB", "DEL", "BOM", "SIN", "HKG", "PVG", "NRT",
	"ICN", "SYD",
] as const

/* ── tracked in-air flights (globe) ─────────────────────────────────── */

/** Live delay status of a tracked flight, as the globe cares about it. */
export type TrackedStatus = "in_air" | "cancelled"

export interface TrackedFlight {
	flightId: string
	origin: string
	dest: string
	/**
	 * Coarse live status. A flight is tracked while its policy is live: still in
	 * the air (not yet marked delayed), or cancelled within the last 24h. Once it
	 * is marked delayed, or cancelled more than 24h ago, or otherwise settled, it
	 * drops off the tracking list.
	 */
	status: TrackedStatus
}

/**
 * The globe plots only the first N tracked flights — a legible board, not the
 * whole list. The left column shows ALL tracked flights.
 */
export const TRACKED_MAP_LIMIT = 10

/** Cancelled flights stay tracked for this grace window, then drop off. */
const CANCELLED_GRACE_SECS = 24 * 60 * 60

/** origin/dest lookup for a flightId, from the FULL fleet table — the
 *  board sells the whole /api/routes catalog, so tracked flights can be
 *  any fleet route, not just the scan-fallback candidates. */
const ROUTE_BY_ID: Record<string, { origin: string; dest: string }> =
	Object.fromEntries(
		FLEET_ROUTES.map((r) => [r.flightId, { origin: r.origin, dest: r.dest }]),
	)

/**
 * A small DEMO set of "in-air, being tracked" flights, used when the
 * oracle's active list is empty (the usual testnet case — nothing
 * whitelisted). Built from DEMO_ROUTES (not FLEET_ROUTES/ROUTE_BY_ID)
 * so this still has something to show even if the fleet file itself is
 * momentarily empty. Clearly labelled demo in UI.
 */
function demoTracked(): TrackedFlight[] {
	// A tracking board: mostly live in the air, with one recently-cancelled
	// flight still in its 24h grace window. Nothing marked delayed (those move
	// to My Policies to be claimed). More than the map cap, so the "all in the
	// list, first 10 on the map" split is visible.
	return DEMO_ROUTES.flatMap((route, i) => {
		if (!airportCoords[route.origin] || !airportCoords[route.dest]) return []
		const status: TrackedStatus = i === DEMO_ROUTES.length - 1 ? "cancelled" : "in_air"
		return [{ flightId: route.flightId, origin: route.origin, dest: route.dest, status }]
	})
}

/**
 * Flights the system is CURRENTLY tracking in the air — i.e. policies people
 * bought that the oracle is watching to see if they land late. We read the
 * oracle's active list, resolve each to a route + live status, DROP cancelled /
 * settled flights (the globe only shows live-in-air + delayed), and cap the set.
 *
 * When the oracle has no active flights (testnet, nothing whitelisted) we fall
 * back to a labelled DEMO set so the globe still reads as a tracking board.
 * `isDemo` tells the page to flag it.
 */
export function useTrackedFlights(): {
	data: TrackedFlight[]
	isDemo: boolean
} {
	const { data: active } = useActiveFlights()
	// Track the FULL active list (it's already bounded on-chain by retention).
	const { data: flightData } = useFlightDataBatch(active)

	return useMemo(() => {
		if (!active || active.length === 0) {
			return { data: demoTracked(), isDemo: true }
		}
		const nowSecs = Math.floor(Date.now() / 1000)
		const dataById = new Map(
			(flightData ?? []).map((f) => [f.flightId, f.data]),
		)
		const tracked: TrackedFlight[] = []
		for (const [flightId] of active) {
			const route = ROUTE_BY_ID[flightId]
			if (!route || !airportCoords[route.origin] || !airportCoords[route.dest])
				continue
			const fd = dataById.get(flightId)
			const tag = fd?.status.tag

			// Marked delayed → leaves the tracking board (moves to claim).
			if (tag === "ToBeSettledDelayed") continue

			// Cancelled → tracked only within the 24h grace window, then drops.
			if (tag === "Cancelled" || tag === "ToBeSettledCancelled") {
				const at = fd?.settled_at ? Number(fd.settled_at) : 0
				if (at > 0 && nowSecs - at > CANCELLED_GRACE_SECS) continue
				tracked.push({
					flightId,
					origin: route.origin,
					dest: route.dest,
					status: "cancelled",
				})
				continue
			}

			// Fully settled (on-time / delayed / old cancel) → resolved, not tracked.
			if (tag === "Settled") continue

			// Everything else is live in the air.
			tracked.push({
				flightId,
				origin: route.origin,
				dest: route.dest,
				status: "in_air",
			})
		}
		// If the live list resolved to nothing usable, still show the demo board.
		if (tracked.length === 0) return { data: demoTracked(), isDemo: true }
		return { data: tracked, isDemo: false }
	}, [active, flightData])
}
