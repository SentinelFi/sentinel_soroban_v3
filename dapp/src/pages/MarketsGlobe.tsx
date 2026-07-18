import { useEffect, useMemo, useRef, useState } from "react"
import {
	geoOrthographic,
	geoPath,
	geoGraticule10,
	geoDistance,
} from "d3-geo"
import * as topojson from "topojson-client"
import worldData from "world-atlas/countries-110m.json"
import {
	airportCoords,
	formatUsdc,
	routeRisk,
	useActiveRoutes,
	useGovernanceDefaults,
	useTrackedFlights,
	TRACKED_MAP_LIMIT,
	INTL_HUBS,
} from "../data"
import type { RiskBand, UiRoute } from "../data"
import { RiskBar } from "../components/RiskBar"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"

/**
 * FLIGHT MAP — a draggable orthographic globe that plots every open market on
 * REAL airport coordinates (airportCoords). Arcs connect origin→dest; nodes and
 * arcs are coloured by the deterministic `routeRisk` band (an ESTIMATE, labelled).
 *
 * Reads go through the data facade. When nothing is whitelisted on-chain the
 * page falls back to the same DEMO candidate list the board uses, flagged as
 * demo (◌ / Sample) per the honesty rule.
 *
 * Themes are genuinely different (not one DOM recoloured):
 *   FUN     = pixel/CRT globe — chunky square markers, hard borders, scanline
 *             stage, arcade glow, board-figure labels.
 *   SERIOUS = radar globe — soft glowing round nodes, thin arcs, a faint
 *             graticule, rounded panels, Outfit + lucide.
 */

/* ── geometry: d3 orthographic projection ────────────────────────── */

interface Rotation {
	/** longitude rotation (drag X) */
	lambda: number
	/** latitude rotation (drag Y), clamped */
	phi: number
}

/**
 * World landmasses decoded once at module load. We MERGE every country polygon
 * into one seamless multipolygon so only coastlines remain — no internal country
 * borders, just continents. 110m is a coarse mesh: cheap to re-path per drag.
 */
// world-atlas ships an untyped Topology; cast so topojson can type it.
const WORLD = worldData as unknown as Parameters<typeof topojson.merge>[0]
const COUNTRIES = (
	WORLD as unknown as {
		objects: { countries: { geometries: Parameters<typeof topojson.merge>[1] } }
	}
).objects.countries.geometries
const LAND = topojson.merge(WORLD, COUNTRIES)
const GRATICULE = geoGraticule10()

const RISK_VAR: Record<RiskBand, string> = {
	low: "var(--color-win)",
	med: "var(--color-gold)",
	high: "var(--color-loss)",
}

/**
 * ~28 major US hubs always drawn on the map as quiet landmark dots, so the globe
 * reads as a real route network even before any market is selected. Airports that
 * actually carry an open market are promoted (risk-coloured + clickable) on top.
 * Codes must exist in `airportCoords`.
 */
const HUB_CODES = [
	"ATL", "LAX", "ORD", "DFW", "DEN", "JFK", "SFO", "SEA", "LAS", "MCO",
	"MIA", "CLT", "EWR", "PHX", "IAH", "BOS", "MSP", "FLL", "DTW", "PHL",
	"LGA", "BWI", "SLC", "DCA", "SAN", "TPA", "PDX", "HNL", "ANC",
] as const

/** The minimal shape the globe + list need — a tracked flight, plottable. */
interface GlobeRoute {
	flightId: string
	origin: string
	dest: string
	/** true → flight was cancelled (within 24h grace); paints red regardless. */
	cancelled: boolean
}

function matchesQuery(route: GlobeRoute, query: string): boolean {
	if (!query.trim()) return true
	const haystack =
		`${route.flightId} ${route.origin} ${route.dest} ${route.origin}-${route.dest}`.toUpperCase()
	return query
		.toUpperCase()
		.split(/[\s,]+/)
		.filter(Boolean)
		.every((token) => haystack.includes(token))
}

/* ── the globe itself ────────────────────────────────────────────── */

const SIZE = 480 // viewBox units, square
const R = 210 // sphere radius in viewBox units
const CX = SIZE / 2
const CY = SIZE / 2

// zoom limits: 1× fills the stage; up to 3.2× to inspect a cluster of hubs.
const ZOOM_MIN = 1
const ZOOM_MAX = 3.2
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))

function Globe({
	routes,
	selectedId,
	onSelect,
	serious,
}: {
	routes: GlobeRoute[]
	selectedId: string | null
	onSelect: (r: GlobeRoute) => void
	serious: boolean
}) {
	// start centred on the continental US (≈39°N, 98°W)
	const [rot, setRot] = useState<Rotation>({ lambda: 98, phi: 39 })
	// zoom multiplies the projection scale; drag pans, wheel/pinch/buttons zoom.
	const [zoom, setZoom] = useState(1)
	const [dragging, setDragging] = useState(false)
	const drag = useRef<{
		x: number
		y: number
		lambda: number
		phi: number
	} | null>(null)

	const onPointerDown = (e: React.PointerEvent) => {
		;(e.target as Element).setPointerCapture?.(e.pointerId)
		drag.current = { x: e.clientX, y: e.clientY, lambda: rot.lambda, phi: rot.phi }
		setDragging(true)
	}
	const onPointerMove = (e: React.PointerEvent) => {
		if (!drag.current) return
		const dx = e.clientX - drag.current.x
		const dy = e.clientY - drag.current.y
		// higher zoom → finer drag so panning stays proportional to what's shown
		const gain = 0.4 / zoom
		setRot({
			lambda: drag.current.lambda + dx * gain,
			// clamp tilt so the sphere never flips inside-out
			phi: Math.max(-89, Math.min(89, drag.current.phi + dy * gain)),
		})
	}
	const endDrag = () => {
		drag.current = null
		setDragging(false)
	}

	// wheel → zoom toward/away (preventDefault stops the page scrolling)
	const onWheel = (e: React.WheelEvent) => {
		e.preventDefault()
		setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
	}

	// keyboard: arrows rotate, +/− zoom (accessibility)
	const onKeyDown = (e: React.KeyboardEvent) => {
		const step = 8
		if (e.key === "ArrowLeft") setRot((r) => ({ ...r, lambda: r.lambda + step }))
		else if (e.key === "ArrowRight")
			setRot((r) => ({ ...r, lambda: r.lambda - step }))
		else if (e.key === "ArrowUp")
			setRot((r) => ({ ...r, phi: Math.min(89, r.phi + step) }))
		else if (e.key === "ArrowDown")
			setRot((r) => ({ ...r, phi: Math.max(-89, r.phi - step) }))
		else if (e.key === "+" || e.key === "=") setZoom((z) => clampZoom(z * 1.15))
		else if (e.key === "-" || e.key === "_") setZoom((z) => clampZoom(z / 1.15))
		else return
		e.preventDefault()
	}

	// airports to plot: the ~28 always-on hubs PLUS any airport touched by an open
	// market. `onRoute` airports are promoted (risk-coloured + clickable); the rest
	// are quiet landmark dots so the network reads even with nothing selected.
	const nodes = useMemo(() => {
		const routeCodes = new Set<string>()
		for (const r of routes) {
			if (airportCoords[r.origin]) routeCodes.add(r.origin)
			if (airportCoords[r.dest]) routeCodes.add(r.dest)
		}
		const codes = new Set<string>(routeCodes)
		for (const c of HUB_CODES) if (airportCoords[c]) codes.add(c)
		for (const c of INTL_HUBS) if (airportCoords[c]) codes.add(c)
		const intlSet = new Set<string>(INTL_HUBS)
		return Array.from(codes).map((code) => ({
			code,
			...airportCoords[code],
			onRoute: routeCodes.has(code),
			// international landmark → quiet dot + light label (never a market here)
			intl: intlSet.has(code) && !routeCodes.has(code),
		}))
	}, [routes])

	// one shared d3 orthographic projection — land, graticule, airports and arcs
	// ALL sample it, so everything stays aligned as the globe spins. The drag
	// state maps onto d3's rotate: longitude drag → rotate[0]; latitude drag →
	// rotate[1] negated (d3 places [-λ, -φ] at the projection centre, so a US
	// centre of lon −98 / lat +39 comes from rotate([98, −39])).
	const projection = useMemo(
		() =>
			geoOrthographic()
				.scale(R * zoom)
				.translate([CX, CY])
				.clipAngle(90)
				.rotate([rot.lambda, -rot.phi]),
		[rot, zoom],
	)

	// pre-baked path strings for land, borders and graticule (coarse mesh, cheap)
	const paths = useMemo(() => {
		const path = geoPath(projection)
		return {
			land: path(LAND) ?? "",
			graticule: path(GRATICULE) ?? "",
		}
	}, [projection])

	// centre of the near hemisphere → used to hide back-of-globe nodes/arcs
	const center = useMemo(
		() => projection.invert?.([CX, CY]) ?? null,
		[projection],
	)

	// project every airport; visible = on the near hemisphere
	const projected = useMemo(() => {
		const map = new Map<
			string,
			{ x: number; y: number; visible: boolean }
		>()
		for (const n of nodes) {
			const xy = projection([n.lon, n.lat])
			const visible =
				!!xy &&
				!!center &&
				geoDistance([n.lon, n.lat], center) <= Math.PI / 2
			map.set(n.code, {
				x: xy ? xy[0] : 0,
				y: xy ? xy[1] : 0,
				visible,
			})
		}
		return map
	}, [nodes, projection, center])

	// arcs for the tracked flights we can place. A flight flagged `delayed` paints
	// red regardless of its estimated risk band; otherwise we use the estimate.
	const arcs = useMemo(() => {
		return routes
			.filter((r) => airportCoords[r.origin] && airportCoords[r.dest])
			.map((r) => {
				const a = projected.get(r.origin)
				const b = projected.get(r.dest)
				const band: RiskBand = r.cancelled
					? "high"
					: routeRisk(r.flightId, `${r.origin}-${r.dest}`).band
				return { r, a, b, band }
			})
			.filter((x) => x.a && x.b && (x.a.visible || x.b.visible))
	}, [routes, projected])

	// selected node halos rendered last (on top)
	const selectedRoute = routes.find((r) => r.flightId === selectedId)

	return (
		<div
			className={`globe-stage${dragging ? " dragging" : ""}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerLeave={endDrag}
			onWheel={onWheel}
			onKeyDown={onKeyDown}
			tabIndex={0}
			role="application"
			aria-label="Draggable flight map. Drag or arrow keys to rotate; scroll or +/− to zoom."
		>
			{!serious && <div className="scanlines pointer-events-none absolute inset-0" />}
			{/* zoom controls */}
			<div className="globe-zoom">
				<button
					type="button"
					className="globe-zoom-btn"
					aria-label="Zoom in"
					onClick={() => setZoom((z) => clampZoom(z * 1.2))}
				>
					+
				</button>
				<button
					type="button"
					className="globe-zoom-btn"
					aria-label="Zoom out"
					onClick={() => setZoom((z) => clampZoom(z / 1.2))}
				>
					−
				</button>
			</div>
			<svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
				<defs>
					<radialGradient id="globe-sphere" cx="42%" cy="38%" r="72%">
						<stop
							offset="0%"
							stopColor={serious ? "#12304a" : "#12294d"}
						/>
						<stop
							offset="100%"
							stopColor={serious ? "#081326" : "#060d1f"}
						/>
					</radialGradient>
					{/* safety clip: nothing may paint outside the sphere disc */}
					<clipPath id="globe-disc">
						<circle cx={CX} cy={CY} r={R} />
					</clipPath>
				</defs>

				{/* ocean sphere (radial-gradient disc) beneath the land */}
				<circle
					cx={CX}
					cy={CY}
					r={R}
					fill="url(#globe-sphere)"
					stroke="var(--color-line-mid)"
					strokeWidth={serious ? 1 : 2}
				/>

				<g clipPath="url(#globe-disc)">
					{/* landmasses — seamless merged continents (coastline only) */}
					<path
						className={
							serious ? "globe-land-serious" : "globe-land-fun"
						}
						d={paths.land}
					/>
					{/* graticule — subtle lat/lon lines matching the projection */}
					<path
						className="globe-graticule"
						d={paths.graticule}
						strokeWidth={serious ? 0.6 : 1}
					/>
				</g>

				{/* arcs */}
				{arcs.map(({ r, a, b, band }, i) => {
					if (!a || !b) return null
					const sel = r.flightId === selectedId
					// gentle quadratic bow toward sphere centre for an "arc" read
					const mx = (a.x + b.x) / 2
					const my = (a.y + b.y) / 2
					const bow = serious ? 0.14 : 0.1
					const cx = mx + (CX - mx) * -bow
					const cy = my + (CY - my) * -bow
					return (
						<path
							key={`arc-${r.flightId}-${i}`}
							className={`${
								serious ? "globe-arc-serious" : "globe-arc-fun"
							}${sel ? " is-selected" : ""}`}
							d={`M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`}
							stroke={RISK_VAR[band]}
						/>
					)
				})}

				{/* base-map hubs (no open market) — quiet neutral landmark dots.
				    International hubs also carry a light label so the globe reads
				    as a world airport map even where no route is approved. */}
				{nodes.map((n) => {
					if (n.onRoute) return null
					const p = projected.get(n.code)
					if (!p || !p.visible) return null
					return (
						<g key={`hub-${n.code}`}>
							{serious ? (
								<circle
									cx={p.x}
									cy={p.y}
									r={2.4}
									className="globe-hub-serious"
								/>
							) : (
								<rect
									x={p.x - 2.5}
									y={p.y - 2.5}
									width={5}
									height={5}
									className="globe-hub-fun"
								/>
							)}
							{n.intl && (
								<text
									x={p.x + 6}
									y={p.y + 3}
									className={
										serious ? "globe-hublabel-serious" : "globe-hublabel-fun"
									}
								>
									{n.code}
								</text>
							)}
						</g>
					)
				})}

				{/* market airports — risk-coloured + clickable, drawn on top */}
				{nodes.map((n) => {
					if (!n.onRoute) return null
					const p = projected.get(n.code)
					if (!p || !p.visible) return null
					// risk band = worst route touching this airport (max delayedPct)
					let band: RiskBand = "low"
					let worst = 0
					for (const r of routes) {
						if (r.origin === n.code || r.dest === n.code) {
							const rk = routeRisk(r.flightId, `${r.origin}-${r.dest}`)
							if (rk.delayedPct > worst) {
								worst = rk.delayedPct
								band = rk.band
							}
						}
					}
					const isSel =
						selectedRoute &&
						(selectedRoute.origin === n.code ||
							selectedRoute.dest === n.code)
					const color = RISK_VAR[band]
					// clicking a node selects the first market touching it
					const selectNode = () => {
						const hit = routes.find(
							(r) => r.origin === n.code || r.dest === n.code,
						)
						if (hit) onSelect(hit)
					}
					if (serious) {
						return (
							<g
								key={n.code}
								onClick={selectNode}
								style={{ cursor: "pointer" }}
							>
								{/* invisible larger hit target */}
								<circle cx={p.x} cy={p.y} r={11} fill="transparent" />
								<circle
									cx={p.x}
									cy={p.y}
									r={isSel ? 7 : 4.5}
									fill={color}
									className={`globe-node-serious${isSel ? " is-selected" : ""}`}
									style={{ filter: `drop-shadow(0 0 5px ${color})` }}
								/>
								<text
									x={p.x + 9}
									y={p.y + 4}
									className={`globe-label-serious${isSel ? " is-selected" : ""}`}
								>
									{n.code}
								</text>
							</g>
						)
					}
					const s = isSel ? 12 : 8
					return (
						<g
							key={n.code}
							onClick={selectNode}
							style={{ cursor: "pointer" }}
						>
							<rect
								x={p.x - 8}
								y={p.y - 8}
								width={16}
								height={16}
								fill="transparent"
							/>
							<rect
								x={p.x - s / 2}
								y={p.y - s / 2}
								width={s}
								height={s}
								fill={color}
								className={`globe-node-fun${isSel ? " is-selected" : ""}`}
							/>
							<text
								x={p.x + 10}
								y={p.y + 5}
								className={`globe-label-fun${isSel ? " is-selected" : ""}`}
							>
								{n.code}
							</text>
						</g>
					)
				})}
			</svg>
		</div>
	)
}

/* ── page ────────────────────────────────────────────────────────── */

export default function MarketsGlobe() {
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"

	// The globe tracks only flights currently IN THE AIR — the policies the
	// system is watching to see if they land late (≤10; cancelled/settled dropped).
	const { data: tracked, isDemo } = useTrackedFlights()
	// terms (premium/payoff) still come from the whitelist resolution, matched by
	// flightId; falls back to governance defaults.
	const { data: routes } = useActiveRoutes()
	const { data: defaults } = useGovernanceDefaults()

	const [query, setQuery] = useState("")
	const [selectedId, setSelectedId] = useState<string | null>(null)

	// tracked flights → plottable globe routes (both endpoints have coords)
	const plottable = useMemo<GlobeRoute[]>(
		() =>
			tracked
				.filter((f) => airportCoords[f.origin] && airportCoords[f.dest])
				.map((f) => ({
					flightId: f.flightId,
					origin: f.origin,
					dest: f.dest,
					cancelled: f.status === "cancelled",
				})),
		[tracked],
	)

	// The left column lists ALL tracked flights; the globe plots only the
	// first N of them (a legible board, not a crowded map).
	const filtered = useMemo(
		() => plottable.filter((r) => matchesQuery(r, query)),
		[plottable, query],
	)
	const mapRoutes = useMemo(
		() => filtered.slice(0, TRACKED_MAP_LIMIT),
		[filtered],
	)

	// default selection: first tracked flight
	useEffect(() => {
		if (!selectedId && plottable.length > 0)
			setSelectedId(plottable[0].flightId)
	}, [plottable, selectedId])

	// resolved on-chain terms for a flightId, if it's whitelisted
	const routeById = useMemo(() => {
		const m = new Map<string, UiRoute>()
		for (const r of routes ?? []) m.set(r.flightId, r)
		return m
	}, [routes])

	function termsOf(flightId: string | null) {
		const r = flightId ? routeById.get(flightId) : undefined
		return {
			premium: r?.terms?.premium ?? defaults?.default_premium,
			payoff: r?.terms?.payoff ?? defaults?.default_payoff,
			delay: r?.terms?.delay_hours ?? defaults?.default_delay_hours,
		}
	}

	return (
		<div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
			{/* header */}
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="h-display text-[22px] leading-[1.35] sm:text-[28px]">
						{t.globe.titleHead}{" "}
						<span className="text-gold">{t.globe.titleTail}</span>
					</h1>
					<p className="mt-3 max-w-xl font-body text-[15px] leading-relaxed text-dim">
						{t.globe.intro}
					</p>
				</div>
				<span className="label-px flex items-center gap-2 text-sky">
					<span className="blink inline-block h-2 w-2 bg-win" />
					{t.globe.hint(plottable.length)}
				</span>
			</div>

			<div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
				{/* LEFT — scrollable flight list (what's being tracked) */}
				<section className="order-2 lg:order-1">
					<div className="mb-3 flex items-center justify-between">
						<h2 className="h-section">{t.globe.listTitle}</h2>
						<span className="label-px">
							{filtered.length}
						</span>
					</div>
					<input
						type="search"
						className="field-px mb-3"
						placeholder={t.globe.searchPlaceholder}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						aria-label={t.globe.searchPlaceholder}
					/>
					<div className="mkt-list-scroll">
						{filtered.map((r) => {
							const terms = termsOf(r.flightId)
							return (
								<button
									key={r.flightId}
									type="button"
									onClick={() => setSelectedId(r.flightId)}
									className={`mkt-row${
										r.flightId === selectedId ? " is-selected" : ""
									}`}
								>
									<span className="flex items-baseline justify-between gap-2">
										<span className="flex items-center gap-2">
											<span className="board-figure text-[20px] text-gold">
												{r.flightId}
											</span>
											<span
												className={`globe-track-tag ${
													r.cancelled ? "is-cancelled" : "is-air"
												}`}
											>
												{r.cancelled
													? t.globe.statusCancelled
													: t.globe.statusInAir}
											</span>
										</span>
										<span className="font-body text-[13px] font-semibold text-ink">
											{r.origin} → {r.dest}
										</span>
									</span>
									<span className="mt-2 flex items-center justify-between gap-2">
										<RiskBar
											flightId={r.flightId}
											route={`${r.origin}-${r.dest}`}
											compact
										/>
										<span className="font-body text-[12px] whitespace-nowrap">
											<span className="text-ink">
												{terms.premium != null
													? formatUsdc(terms.premium)
													: "…"}
											</span>
											<span className="mx-1 text-mute">→</span>
											<span className="text-win">
												{terms.payoff != null
													? formatUsdc(terms.payoff)
													: "…"}
											</span>
										</span>
									</span>
								</button>
							)
						})}
					</div>
				</section>

				{/* CENTER — the globe */}
				<section className="order-1 space-y-3 lg:order-2">
					<Globe
						routes={mapRoutes}
						selectedId={selectedId}
						onSelect={(r) => setSelectedId(r.flightId)}
						serious={serious}
					/>
					{/* legend */}
					<div className="flex flex-wrap items-center gap-4 border-2 border-line bg-surface px-4 py-2.5">
						<span className="label-px">{t.globe.legendTitle}</span>
						<span className="flex items-center gap-1.5 font-body text-[12px] text-dim">
							<span
								className="risk-dot"
								style={{ background: RISK_VAR.low, color: RISK_VAR.low }}
							/>
							{t.globe.legendLow}
						</span>
						<span className="flex items-center gap-1.5 font-body text-[12px] text-dim">
							<span
								className="risk-dot"
								style={{ background: RISK_VAR.med, color: RISK_VAR.med }}
							/>
							{t.globe.legendMed}
						</span>
						<span className="flex items-center gap-1.5 font-body text-[12px] text-dim">
							<span
								className="risk-dot"
								style={{ background: RISK_VAR.high, color: RISK_VAR.high }}
							/>
							{t.globe.legendHigh}
						</span>
					</div>
					{filtered.length > mapRoutes.length && (
						<p className="font-body text-[12px] text-sky">
							{t.globe.mapNote(mapRoutes.length, filtered.length)}
						</p>
					)}
					<p className="font-body text-[12px] text-mute">
						{t.globe.riskNote}
						{isDemo && (
							<span className="ml-2 text-gold">{t.globe.demoNote}</span>
						)}
					</p>
				</section>
			</div>
		</div>
	)
}
