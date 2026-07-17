import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import type { FlightData } from "oracle_aggregator"
import {
	controllerClient,
	formatUsdc,
	useActiveFlights,
	useActiveRoutes,
	useContractSync,
	useFlightDataBatch,
	useGovernanceDefaults,
	useIsWhitelisted,
	useWhitelistEnabled,
} from "../hooks/useContracts"
import type { UiRoute } from "../hooks/useContracts"
import { CANDIDATE_ROUTES } from "../config/routes"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import { formatDate } from "../lib/utils"
import { PixelArt } from "../components/PixelArt"
import { HowItWorksBubble } from "../components/InfoBubble"
import { TransactionButton } from "../components/TransactionButton"
import type { TxState } from "../types"

/** Midnight-UTC-aligned unix timestamp (u64) for a YYYY-MM-DD date string. */
function dateStrToMidnightUtc(dateStr: string): bigint {
	const [y = 0, m = 1, d = 1] = dateStr.split("-").map(Number)
	return BigInt(Date.UTC(y, m - 1, d) / 1000)
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10)
}

interface Defaults {
	default_premium: bigint
	default_payoff: bigint
	default_delay_hours: number
}

/** Per-route stake/win, falling back to on-chain governance defaults. */
function termsFor(route: UiRoute, defaults?: Defaults) {
	return {
		premium: route.terms?.premium ?? defaults?.default_premium,
		payoff: route.terms?.payoff ?? defaults?.default_payoff,
	}
}

/**
 * Odds multiple: payoff / premium, e.g. 500/50 = 10x.
 * Falls back to on-chain governance defaults for DEMO rows without terms.
 */
function oddsFor(route: UiRoute, defaults?: Defaults): string {
	const { premium, payoff } = termsFor(route, defaults)
	if (premium === undefined || payoff === undefined || premium === 0n)
		return "10x"
	const mult = Number(payoff) / Number(premium)
	return Number.isInteger(mult) ? `${mult}x` : `${mult.toFixed(1)}x`
}

/**
 * Shown while the chain scan streams in, and whenever the chain has no
 * whitelisted routes (same fallback the classic frontend uses) — clearly
 * flagged as DEMO on the board. The full 200-flight candidate list keeps
 * the board searchable even before any route resolves on-chain.
 */
const SAMPLE_ROUTES: UiRoute[] = CANDIDATE_ROUTES.map((route) => ({
	...route,
	status: "Active",
	terms: null,
}))

/** Rows per page of the departures board. */
const BOARD_PAGE_SIZE = 12

/** Case-insensitive multi-token match on flight id / airport codes. */
function matchesQuery(route: UiRoute, query: string): boolean {
	if (!query.trim()) return true
	const haystack =
		`${route.flightId} ${route.origin} ${route.dest} ${route.origin}-${route.dest}`.toUpperCase()
	return query
		.toUpperCase()
		.split(/[\s,]+/)
		.filter(Boolean)
		.every((token) => haystack.includes(token))
}

type OracleTag = FlightData["status"]["tag"]

const LIVE_STATUS: Record<OracleTag, { label: string; color: string }> = {
	NotInitiated: { label: "SCHEDULED", color: "text-mute" },
	Active: { label: "IN AIR", color: "text-sky" },
	Landed: { label: "LANDED", color: "text-dim" },
	Cancelled: { label: "CANCELLED", color: "text-loss" },
	ToBeSettledOnTime: { label: "ON TIME", color: "text-win" },
	ToBeSettledDelayed: { label: "DELAYED", color: "text-loss" },
	ToBeSettledCancelled: { label: "CANCELLED", color: "text-loss" },
	Settled: { label: "SETTLED", color: "text-mute" },
}

/* ── ticker ──────────────────────────────────────────────────── */

function Ticker({
	liveFlights,
}: {
	liveFlights: Array<{ flightId: string; tag: OracleTag | null }>
}) {
	const chips =
		liveFlights.length > 0
			? liveFlights.map((f) => ({
					code: f.flightId,
					status: f.tag ? LIVE_STATUS[f.tag] : LIVE_STATUS.NotInitiated,
				}))
			: [
					{ code: "AA100", status: LIVE_STATUS.ToBeSettledDelayed },
					{ code: "UA200", status: LIVE_STATUS.ToBeSettledOnTime },
					{ code: "DL300", status: LIVE_STATUS.Active },
				]

	// duplicate content for a seamless -50% marquee loop
	const loop = [...chips, ...chips, ...chips, ...chips]

	return (
		<div className="flex items-center gap-3 overflow-hidden border-2 border-line bg-inset py-2">
			<span className="z-10 flex shrink-0 items-center gap-2 border-r-2 border-line bg-inset pl-3 pr-3">
				<span className="blink inline-block h-2 w-2 bg-win" />
				<span className="label-px text-win">LIVE</span>
			</span>
			<div className="marquee-track gap-6">
				{loop.map((chip, i) => (
					<span
						key={`${chip.code}-${i}`}
						className="flex items-center gap-2 whitespace-nowrap"
					>
						<span className="font-board text-[19px] text-ink">
							{/* marquee scrolls leftward — flip the glyph to fly with it */}
							<span className="inline-block -scale-x-100">✈</span>{" "}
							{chip.code}
						</span>
						<span className={`status-px ${chip.status.color}`}>
							{chip.status.label}
						</span>
					</span>
				))}
			</div>
		</div>
	)
}

/* ── bet slip (boarding pass) ────────────────────────────────── */

function BetSlip({
	route,
	defaults,
	onClose,
}: {
	route: UiRoute
	defaults?: Defaults
	onClose: () => void
}) {
	const { address, signTransaction } = useWallet()
	const { addNotification } = useNotification()
	const queryClient = useQueryClient()
	const [flightDate, setFlightDate] = useState("")
	const [txState, setTxState] = useState<TxState>("idle")
	const [error, setError] = useState<string | null>(null)

	const { data: whitelistEnabled } = useWhitelistEnabled()
	const { data: isWhitelisted } = useIsWhitelisted(address)
	const whitelistBlocked =
		whitelistEnabled === true && !!address && isWhitelisted === false

	const premium = route.terms?.premium ?? defaults?.default_premium
	const payoff = route.terms?.payoff ?? defaults?.default_payoff
	const delayHours = route.terms?.delay_hours ?? defaults?.default_delay_hours

	const placeBet = async () => {
		if (!address || !flightDate || whitelistBlocked) return
		setTxState("awaiting")
		setError(null)
		try {
			const tx = await controllerClient.buy_insurance({
				traveler: address,
				flight_id: route.flightId,
				origin: route.origin,
				dest: route.dest,
				date: dateStrToMidnightUtc(flightDate),
			})
			setTxState("confirming")
			await tx.signAndSend({ signTransaction })
			setTxState("success")
			addNotification(
				`Covered: ${route.flightId} on ${flightDate} — pays if delayed`,
				"success",
			)
			void queryClient.invalidateQueries({ queryKey: ["controller"] })
			void queryClient.invalidateQueries({ queryKey: ["usdc"] })
			setTimeout(() => {
				setTxState("idle")
				onClose()
			}, 1500)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Transaction failed")
			setTxState("error")
			setTimeout(() => setTxState("idle"), 3000)
		}
	}

	return (
		<div className="fixed inset-0 z-40 flex justify-end">
			{/* scrim */}
			<button
				type="button"
				aria-label="Close insurance slip"
				onClick={onClose}
				className="absolute inset-0 bg-page/85"
			/>
			<aside className="panel-raised relative z-10 flex h-full w-full max-w-[380px] flex-col gap-4 overflow-y-auto p-5">
				<div className="flex items-start justify-between">
					<div>
						<p className="label-px text-gold">BOARDING PASS</p>
						<h2 className="h-display mt-1 text-[15px]">
							INSURANCE SLIP
						</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="btn-px btn-ghost btn-sm"
					>
						✕
					</button>
				</div>

				<PixelArt name="betslip-plane" className="floaty h-20 w-full" />

				<div className="panel-inset p-3">
					<div className="flex items-baseline justify-between">
						<span className="board-figure text-[26px]">
							{route.flightId}
						</span>
						<span className="status-px text-loss">
							DELAYED PAYS {oddsFor(route, defaults)}
						</span>
					</div>
					<p className="mt-2 font-body text-[14px] text-dim">
						<span className="font-board text-[20px] leading-none text-ink">
							{route.origin} ✈ {route.dest}
						</span>
						{delayHours !== undefined && (
							<span className="ml-2 text-mute">
								pays if &gt;{delayHours}h late
							</span>
						)}
					</p>
				</div>

				<label className="block">
					<span className="label-px mb-1 block">FLIGHT DATE (UTC)</span>
					<input
						type="date"
						name="flight-date"
						className="field-px"
						min={todayStr()}
						value={flightDate}
						onChange={(e) => setFlightDate(e.target.value)}
					/>
				</label>

				{/* perforation */}
				<div className="border-t-2 border-dashed border-line-mid" />

				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<span className="label-px">PREMIUM (FIXED)</span>
						<span className="board-figure text-[22px] text-ink">
							{premium !== undefined ? formatUsdc(premium) : "…"} USDC
						</span>
					</div>
					<div className="flex items-center justify-between">
						<span className="label-px text-win">
							PAYOUT IF DELAYED
						</span>
						<span className="board-figure text-[26px] text-win">
							{payoff !== undefined ? formatUsdc(payoff) : "…"} USDC
						</span>
					</div>
				</div>

				<TransactionButton
					state={txState}
					onClick={() => void placeBet()}
					disabled={!address || !flightDate || whitelistBlocked}
					className="btn-loss w-full"
				>
					BUY COVER ✈ {premium !== undefined ? formatUsdc(premium) : "…"}{" "}
					USDC
				</TransactionButton>

				{!address && (
					<p className="font-body text-[13px] text-gold">
						Connect your wallet to buy this cover.
					</p>
				)}
				{whitelistBlocked && (
					<p className="font-body text-[13px] text-gold">
						Cover is currently limited to approved buyers.
					</p>
				)}
				{error && (
					<p className="break-words font-body text-[13px] text-loss">
						{error}
					</p>
				)}

				<p className="mt-auto font-body text-[13px] leading-relaxed text-mute">
					Buying cover IS betting your flight lands late: the premium
					is your stake on DELAYED. An oracle settles the flight
					on-chain after it lands. No claims forms.
				</p>
			</aside>
		</div>
	)
}

/* ── page ────────────────────────────────────────────────────── */

export default function Markets() {
	const navigate = useNavigate()
	useContractSync()
	const [slipRoute, setSlipRoute] = useState<UiRoute | null>(null)
	const [query, setQuery] = useState("")
	const [page, setPage] = useState(0)

	const {
		data: routes,
		isLoading: routesLoading,
		isFetching: routesFetching,
	} = useActiveRoutes()
	const { data: defaults } = useGovernanceDefaults()
	const { data: activeFlights } = useActiveFlights()
	const { data: flightData } = useFlightDataBatch(activeFlights)

	// Never block the board on the chunked chain scan: demo rows render
	// immediately and are swapped for live rows as chunks stream in
	// (useRoutes publishes partial results per chunk on the first scan).
	const isDemo = !routes || routes.length === 0
	const scanning = isDemo && (routesLoading || routesFetching)
	const displayRoutes = isDemo ? SAMPLE_ROUTES : routes

	// Search-first board: with 100s of whitelisted flights a raw list is
	// unusable — filter by flight number or airport code across ALL rows,
	// then page the results 12 at a time (search resets to page 1).
	const filtered = displayRoutes.filter((route) =>
		matchesQuery(route, query),
	)
	const pageCount = Math.max(1, Math.ceil(filtered.length / BOARD_PAGE_SIZE))
	const safePage = Math.min(page, pageCount - 1)
	const visible = filtered.slice(
		safePage * BOARD_PAGE_SIZE,
		(safePage + 1) * BOARD_PAGE_SIZE,
	)

	const liveRows = (flightData ?? []).map((f) => ({
		flightId: f.flightId,
		date: f.date,
		tag: f.data ? f.data.status.tag : null,
	}))

	return (
		<div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
			{/* hero — headline row, then a full-width night-airfield band.
			    The band keeps the art's exact 400:148 aspect so the runway
			    line stays put at every width; the plane lands on it. */}
			<section>
				<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
					<h1 className="h-display text-[24px] leading-[1.45] sm:text-[32px]">
						INSURE YOUR FLIGHT.
						<br />
						<span className="text-loss">GET PAID IF IT'S LATE.</span>
					</h1>
					<p className="max-w-sm font-body text-[15px] leading-relaxed text-dim">
						Buying insurance here IS betting your flight lands late.
						Stake a fixed premium; if the flight is{" "}
						<span className="font-semibold text-loss">delayed</span>{" "}
						past the threshold, the payout is yours automatically.
					</p>
				</div>

				<div className="relative mt-6 overflow-hidden border-2 border-line">
					<PixelArt
						name="hero-airfield"
						className="aspect-[400/148] w-full"
					/>
					{/* landing loop — the plane's static spot IS the parked-on-
					    runway pose, so reduced motion still shows it landed */}
					<div className="land-track" aria-hidden="true">
						<img
							src="/px/plane-fly.png"
							alt=""
							draggable={false}
							className="land-plane pixelated absolute h-auto"
							style={{ left: "9%", top: "76%", width: "5.7%" }}
						/>
					</div>
				</div>
			</section>

			<Ticker liveFlights={liveRows} />

			{/* THE DEPARTURES BOARD — signature artifact */}
			<section>
				<div className="flex items-center justify-between border-2 border-b-0 border-line bg-raised px-4 py-3">
					<h2 className="h-section flex items-center gap-3">
						<span className="floaty inline-block">✈</span> DEPARTURES —
						OPEN MARKETS
						<HowItWorksBubble />
					</h2>
					<span className="label-px hidden sm:block">
						PAY PREMIUM → PAID IF DELAYED<span className="blink">▊</span>
					</span>
				</div>

				{/* search toolbar — filters all rows, resets to page 1 */}
				<div className="flex flex-wrap items-center gap-3 border-2 border-b-0 border-line bg-surface px-4 py-3">
					<div className="relative w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-[340px]">
						<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-board text-[18px] text-mute">
							⌕
						</span>
						<input
							type="search"
							name="board-search"
							className="field-px pl-9"
							placeholder="Flight or airport… (AA100, JFK)"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value)
								setPage(0)
							}}
							aria-label="Search flights by number or airport code"
						/>
					</div>
					<span className="label-px ml-auto">
						{`${filtered.length} FLIGHT${filtered.length === 1 ? "" : "S"}`}
						{scanning && (
							<span className="ml-2 text-sky">
								· SCANNING CHAIN<span className="blink">…</span>
							</span>
						)}
					</span>
				</div>

				<div className="relative overflow-x-auto border-2 border-line bg-inset">
					<div className="scanlines absolute inset-0" />
					<table className="w-full min-w-[820px] border-collapse">
						<thead>
							<tr className="border-b-2 border-line text-left">
								{[
									"FLIGHT",
									"ROUTE",
									"DATE",
									"STATUS",
									"PREMIUM → PAYOUT",
									"",
								].map((h) => (
									<th
										key={h}
										className="label-px px-4 py-2 font-normal"
									>
										{h}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{filtered.length === 0 && (
								<tr>
									<td colSpan={6} className="px-4 py-10 text-center">
										<span className="block font-board text-[24px] text-dim">
											NO FLIGHTS MATCH “{query.trim().toUpperCase()}”
										</span>
										<span className="mt-1 block font-body text-[13px] text-mute">
											Try a flight number or an airport code.
										</span>
									</td>
								</tr>
							)}
							{visible.map((route) => (
								<tr
									key={`${route.flightId}-${route.origin}-${route.dest}`}
									className="border-b-2 border-line/60 hover:bg-raised/60"
								>
									<td className="board-figure px-4 py-3">
										{route.flightId}
									</td>
									<td className="px-4 py-3 font-body text-[14px] font-semibold tracking-[0.04em] text-ink">
										{route.origin} → {route.dest}
									</td>
									<td className="px-4 py-3 font-body text-[13px] text-mute">
										YOU PICK
									</td>
									<td className="px-4 py-3">
										{isDemo ? (
											<span className="status-px text-gold">
												{scanning ? "◌ SCANNING" : "◌ DEMO"}
											</span>
										) : (
											<span className="status-px text-win">
												● BOARDING
											</span>
										)}
									</td>
									<td className="px-4 py-3 whitespace-nowrap">
										{(() => {
											const { premium, payoff } = termsFor(
												route,
												defaults,
											)
											return (
												<span className="font-body text-[14px] font-semibold">
													<span className="text-ink">
														{premium !== undefined
															? formatUsdc(premium)
															: "…"}
													</span>
													<span className="mx-1 font-normal text-mute">
														→
													</span>
													<span className="text-win">
														{payoff !== undefined
															? formatUsdc(payoff)
															: "…"}
													</span>
													<span className="ml-1 text-[11px] font-normal text-mute">
														USDC
													</span>
												</span>
											)
										})()}
									</td>
									<td className="px-4 py-3">
										<div className="relative z-10 flex justify-end gap-2">
											<button
												type="button"
												onClick={() => setSlipRoute(route)}
												className="btn-px btn-loss btn-sm"
											>
												INSURE ✈ {oddsFor(route, defaults)}
											</button>
											<button
												type="button"
												onClick={() => void navigate("/house")}
												className="btn-px btn-win btn-sm"
												title="Take the other side — underwrite flights from the pool"
											>
												EARN YIELD
											</button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				{/* pagination — page through the whole board, 12 rows at a time */}
				{filtered.length > 0 && (
					<div className="flex flex-wrap items-center justify-between gap-3 border-2 border-t-0 border-line bg-raised px-4 py-3">
						<span className="label-px">
							PAGE {safePage + 1} OF {pageCount} ·{" "}
							{filtered.length} FLIGHT
							{filtered.length === 1 ? "" : "S"}
						</span>
						<div className="flex items-center gap-3">
							<button
								type="button"
								className="page-btn"
								onClick={() => setPage(Math.max(0, safePage - 1))}
								disabled={safePage === 0}
								aria-label="Previous page"
							>
								◀ PREV
							</button>
							<span className="font-display text-[9px] tracking-[0.04em] text-ink">
								PAGE {safePage + 1}/{pageCount}
							</span>
							<button
								type="button"
								className="page-btn"
								onClick={() =>
									setPage(Math.min(pageCount - 1, safePage + 1))
								}
								disabled={safePage >= pageCount - 1}
								aria-label="Next page"
							>
								NEXT ▶
							</button>
						</div>
					</div>
				)}

				<p className="mt-3 font-body text-[13px] text-mute">
					<span className="font-semibold text-win">EARN YIELD</span>{" "}
					takes the other side: it routes you to the underwriting pool,
					where on-time premiums become your yield.
					{isDemo && !scanning && (
						<span className="ml-2 text-gold">
							◌ DEMO rows — no live markets whitelisted on-chain right
							now.
						</span>
					)}
				</p>
			</section>

			{/* in-flight markets */}
			<section>
				<h2 className="h-section mb-3">
					IN THE AIR — AWAITING SETTLEMENT
				</h2>
				{liveRows.length === 0 ? (
					<div className="panel p-6 text-center">
						<p className="font-board text-[22px] text-dim">
							NO FLIGHTS IN THE AIR RIGHT NOW
						</p>
						<p className="mt-1 font-body text-[13px] text-mute">
							Covered flights appear here while the oracle tracks them.
						</p>
					</div>
				) : (
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{liveRows.map((row) => {
							const status = row.tag
								? LIVE_STATUS[row.tag]
								: LIVE_STATUS.NotInitiated
							const stormy =
								row.tag === "ToBeSettledDelayed" ||
								row.tag === "Cancelled" ||
								row.tag === "ToBeSettledCancelled"
							return (
								<div
									key={`${row.flightId}-${row.date.toString()}`}
									className="panel flex items-center gap-3 p-4"
								>
									<PixelArt
										name={stormy ? "weather-storm" : "weather-sun"}
										icon
										className="h-10 w-10 shrink-0"
									/>
									<div className="min-w-0">
										<p className="board-figure text-[22px]">
											{row.flightId}
										</p>
										<p className="mt-1 font-body text-[13px] text-mute">
											{formatDate(row.date)}
										</p>
									</div>
									<span className={`ml-auto status-px ${status.color}`}>
										{status.label}
									</span>
								</div>
							)
						})}
					</div>
				)}
			</section>

			{slipRoute && (
				<BetSlip
					route={slipRoute}
					defaults={defaults}
					onClose={() => setSlipRoute(null)}
				/>
			)}
		</div>
	)
}
