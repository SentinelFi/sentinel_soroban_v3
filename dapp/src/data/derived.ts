/**
 * Derived selectors — thin, deterministic transforms layered on top of the
 * contract hooks in `useContracts`. Anything synthesized here is an ESTIMATE
 * or ILLUSTRATIVE series (labelled as such in the UI), NOT precise on-chain
 * truth. The one exception is `airportCoords`, which is real geographic data.
 *
 * Honesty rule (see conventions): no route is whitelisted on testnet, so live
 * per-route risk history does not exist. `routeRisk` and the sparkline series
 * are deterministic pseudo-values seeded from stable inputs so they are stable
 * across renders and clearly demo-grade. Callers must label them.
 */

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import {
	riskVaultClient,
	useActiveFlights,
	useFlightDataBatch,
} from "../hooks/useContracts"
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

export type RiskBand = "low" | "med" | "high"

export interface RouteRisk {
	/** Estimated % of departures delayed past threshold (0–100). */
	delayedPct: number
	band: RiskBand
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
 * Deterministic estimated delay risk for a flight/route. Prefers the static
 * table when a route key is known; otherwise hashes the id into a plausible
 * band centred near 20% delayed. ALWAYS an estimate — label it in the UI.
 */
export function routeRisk(flightId: string, route?: string): RouteRisk {
	let delayedPct: number
	const key = route?.toUpperCase()
	if (key && ROUTE_DELAY_TABLE[key] !== undefined) {
		delayedPct = ROUTE_DELAY_TABLE[key]
	} else {
		// hash → 8..44%, centred ~20%, stable per id
		const r = seededRng(hashStr(`${flightId}|${route ?? ""}`))()
		delayedPct = Math.round(8 + r * 36)
	}
	const band: RiskBand =
		delayedPct >= 40 ? "high" : delayedPct >= 25 ? "med" : "low"
	return { delayedPct, band }
}

/* ── illustrative 30-day series (TVL / APY sparklines) ─────────────── */

/**
 * Build a plausible trending 30-point series, deterministic per seed. Not real
 * history — the UI labels these "illustrative". Values wobble around a rising
 * baseline so a sparkline reads as a believable trend without implying data.
 */
function illustrativeSeries(
	seed: number,
	base: number,
	drift: number,
	jitter: number,
	points = 30,
): number[] {
	const rng = seededRng(seed)
	const out: number[] = []
	let v = base
	for (let i = 0; i < points; i++) {
		v += drift + (rng() - 0.5) * jitter
		if (v < base * 0.4) v = base * 0.4
		out.push(Math.round(v * 100) / 100)
	}
	return out
}

/**
 * 30-day ILLUSTRATIVE TVL series. Deterministic; not on-chain history.
 * Label as illustrative wherever it renders.
 */
export function useTvlSparkline(): number[] {
	const { data } = useQuery({
		queryKey: ["derived", "tvlSparkline"],
		queryFn: async () => illustrativeSeries(hashStr("tvl"), 42000, 260, 1400),
		staleTime: Infinity,
	})
	return data ?? []
}

/**
 * 30-day ILLUSTRATIVE APY series (%). Deterministic; not on-chain history.
 * Label as illustrative wherever it renders.
 */
export function useApySparkline(): number[] {
	const { data } = useQuery({
		queryKey: ["derived", "apySparkline"],
		queryFn: async () => illustrativeSeries(hashStr("apy"), 11, 0.04, 1.1),
		staleTime: Infinity,
	})
	return data ?? []
}

/* ── share-price series (REAL where available) ─────────────────────── */

export interface SharePricePoint {
	day: number
	price: number
}

export interface SharePriceSeries {
	points: SharePricePoint[]
	/** true when the series is synthesized (no on-chain snapshots found). */
	illustrative: boolean
}

const SHARE_PRICE_SCALE = 10_000_000 // USDC 7-decimals

/**
 * Read `get_snapshot_price(day)` for the last `days` day-indices and return the
 * non-zero points. Snapshots are REAL on-chain data. If the vault has taken no
 * snapshots yet, fall back to a short synthesized series flagged
 * `illustrative: true` so the UI can label it honestly.
 */
export function useSharePriceSeries(days = 14) {
	return useQuery<SharePriceSeries>({
		queryKey: ["derived", "sharePriceSeries", days],
		queryFn: async () => {
			const today = Math.floor(Date.now() / 1000 / 86_400)
			const dayIdx = Array.from({ length: days }, (_, i) => today - (days - 1 - i))
			const results = await Promise.all(
				dayIdx.map(async (day) => {
					try {
						const tx = await riskVaultClient.get_snapshot_price({
							day: BigInt(day),
						})
						return { day, raw: tx.result as bigint }
					} catch {
						return { day, raw: 0n }
					}
				}),
			)
			const points = results
				.filter((r) => r.raw !== 0n)
				.map((r) => ({ day: r.day, price: Number(r.raw) / SHARE_PRICE_SCALE }))

			if (points.length >= 2) {
				return { points, illustrative: false }
			}

			// No real snapshots — synthesize a short gently-rising series so the
			// chart is never empty. Flagged illustrative; UI must label it.
			const rng = seededRng(hashStr("sharePrice"))
			const synth: SharePricePoint[] = dayIdx.map((day, i) => ({
				day,
				price: Math.round((1 + i * 0.004 + (rng() - 0.5) * 0.003) * 1e4) / 1e4,
			}))
			return { points: synth, illustrative: true }
		},
		staleTime: 300_000,
		retry: 1,
	})
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
