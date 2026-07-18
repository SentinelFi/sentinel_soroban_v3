import { useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
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
import { PixelArt } from "../components/PixelArt"
import { SeriousIcon } from "../components/SeriousIcon"
import { HowItWorksBubble } from "../components/InfoBubble"
import { TransactionButton } from "../components/TransactionButton"
import { RiskBar } from "../components/RiskBar"
import { FlightCalendar } from "../components/FlightCalendar"
import {
	useProtocolStats,
	useTotalAssets,
	useFreeCapital,
} from "../data"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"
import type { TxState } from "../types"

/** Midnight-UTC-aligned unix timestamp (u64) for a YYYY-MM-DD date string. */
function dateStrToMidnightUtc(dateStr: string): bigint {
	const [y = 0, m = 1, d = 1] = dateStr.split("-").map(Number)
	return BigInt(Date.UTC(y, m - 1, d) / 1000)
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
		<div className="ticker flex items-center gap-3 overflow-hidden border-2 border-line bg-inset py-2">
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

/* ── stats ticker (real protocol numbers) ───────────────────── */

/**
 * Scrolling strip of REAL, live protocol numbers pulled from the data facade
 * (TVL, free capital, premiums, travelers, open-markets count). Same pixel
 * marquee mechanic as the flight ticker; the serious skin rounds the rail.
 */
function StatsTicker({ openMarkets }: { openMarkets: number }) {
	const t = useCopy()
	const { data: stats } = useProtocolStats()
	const { data: tvl } = useTotalAssets()
	const { data: free } = useFreeCapital()

	const items: Array<{ label: string; value: string }> = [
		{
			label: t.statsTicker.tvl,
			value: `${tvl != null ? formatUsdc(tvl) : "…"} USDC`,
		},
		{
			label: t.statsTicker.free,
			value: `${free != null ? formatUsdc(free) : "…"} USDC`,
		},
		{
			label: t.statsTicker.premiums,
			value: `${stats ? formatUsdc(stats.totalPremiums) : "…"} USDC`,
		},
		{
			label: t.statsTicker.travelers,
			value: stats ? stats.totalTravelers.toLocaleString() : "…",
		},
		{ label: t.statsTicker.openMarkets, value: openMarkets.toLocaleString() },
	]

	const loop = [...items, ...items, ...items, ...items]

	return (
		<div className="ticker flex items-center gap-3 overflow-hidden border-2 border-line bg-inset py-2">
			<span className="z-10 flex shrink-0 items-center gap-2 border-r-2 border-line bg-inset pl-3 pr-3">
				<span className="label-px text-gold">{t.statsTicker.tag}</span>
			</span>
			<div className="marquee-track gap-8">
				{loop.map((item, i) => (
					<span
						key={`${item.label}-${i}`}
						className="flex items-baseline gap-2 whitespace-nowrap"
					>
						<span className="label-px text-mute">{item.label}</span>
						<span className="font-board text-[19px] text-ink">
							{item.value}
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
	const t = useCopy()
	const { theme } = useTheme()
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
				aria-label={t.slip.closeAria}
				onClick={onClose}
				className="absolute inset-0 bg-page/85"
			/>
			<aside className="slip-panel panel-raised relative z-10 flex h-full w-full max-w-[380px] flex-col gap-4 overflow-y-auto p-5">
				<div className="flex items-start justify-between">
					<div>
						<p className="label-px text-gold">{t.slip.eyebrow}</p>
						<h2 className="h-display mt-1 text-[15px]">
							{t.slip.title}
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

				{theme === "serious" ? (
					<div className="flex items-center justify-center py-2 text-highlight">
						<SeriousIcon name="plane" className="h-12 w-12" />
					</div>
				) : (
					<PixelArt
						name="betslip-plane"
						className="floaty h-20 w-full"
					/>
				)}

				<div className="panel-inset p-3">
					<div className="flex items-baseline justify-between">
						<span className="board-figure text-[26px]">
							{route.flightId}
						</span>
						<span className="status-px text-loss">
							{t.slip.oddsLabel(oddsFor(route, defaults))}
						</span>
					</div>
					<p className="mt-2 font-body text-[14px] text-dim">
						<span className="font-board text-[20px] leading-none text-ink">
							{route.origin} ✈ {route.dest}
						</span>
						{delayHours !== undefined && (
							<span className="ml-2 text-mute">
								{t.slip.threshold(delayHours)}
							</span>
						)}
					</p>
				</div>

				<div className="block">
					<span className="label-px mb-1 block">
						{t.slip.dateLabel}
					</span>
					<FlightCalendar
						value={flightDate}
						onChange={setFlightDate}
					/>
				</div>

				{/* perforation */}
				<div className="border-t-2 border-dashed border-line-mid" />

				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<span className="label-px">{t.slip.premiumLabel}</span>
						<span className="board-figure text-[22px] text-ink">
							{premium !== undefined ? formatUsdc(premium) : "…"} USDC
						</span>
					</div>
					<div className="flex items-center justify-between">
						<span className="label-px text-win">
							{t.slip.payoutLabel}
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
					{t.slip.cta(premium !== undefined ? formatUsdc(premium) : "…")}
				</TransactionButton>

				{!address && (
					<p className="font-body text-[13px] text-gold">
						{t.slip.connectPrompt}
					</p>
				)}
				{whitelistBlocked && (
					<p className="font-body text-[13px] text-gold">
						{t.slip.blockedPrompt}
					</p>
				)}
				{error && (
					<p className="break-words font-body text-[13px] text-loss">
						{error}
					</p>
				)}

				<p className="mt-auto font-body text-[13px] leading-relaxed text-mute">
					{t.slip.fineprint}
				</p>
			</aside>
		</div>
	)
}

/* ── page ────────────────────────────────────────────────────── */

export default function Markets() {
	const navigate = useNavigate()
	const [searchParams, setSearchParams] = useSearchParams()
	useContractSync()
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
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

	// Deep-link from the Flight Map (/markets?flight=AA100): preselect the row,
	// open its slip, and set the search box so the row is visible. One-shot —
	// clears the param after consuming it so closing the slip doesn't re-open.
	const deepLinkFlight = searchParams.get("flight")
	useEffect(() => {
		if (!deepLinkFlight) return
		const match = displayRoutes.find(
			(r) => r.flightId.toUpperCase() === deepLinkFlight.toUpperCase(),
		)
		if (match) {
			setSlipRoute(match)
			setQuery(match.flightId)
			setPage(0)
		}
		searchParams.delete("flight")
		setSearchParams(searchParams, { replace: true })
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [deepLinkFlight, displayRoutes.length])

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
			{serious ? (
				/* serious hero — big Outfit headline with a gradient clip,
				   floated over the canvas flight-paths already behind it.
				   No pixel airfield, no pixel plane. */
				<section className="hero-serious relative py-10 sm:py-16">
					<h1 className="hero-serious-title font-display text-[40px] font-bold leading-[1.02] tracking-[-0.02em] sm:text-[64px]">
						{t.markets.heroLine1}
						<br />
						<span className="hero-grad">{t.markets.heroLine2}</span>
					</h1>
					<p className="mt-6 max-w-xl font-body text-[16px] leading-relaxed text-dim sm:text-[18px]">
						{t.markets.heroSub}
					</p>
				</section>
			) : (
				/* fun hero — headline row, then a full-width night-airfield band.
				    The band keeps the art's exact 400:148 aspect so the runway
				    line stays put at every width; the plane lands on it. */
				<section>
					<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
						<h1 className="h-display text-[24px] leading-[1.45] sm:text-[32px]">
							INSURE YOUR FLIGHT.
							<br />
							<span className="text-loss">
								GET PAID IF IT'S LATE.
							</span>
						</h1>
						<p className="max-w-sm font-body text-[15px] leading-relaxed text-dim">
							Buying insurance here IS betting your flight lands
							late. Stake a fixed premium; if the flight is{" "}
							<span className="font-semibold text-loss">
								delayed
							</span>{" "}
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
			)}

			<Ticker liveFlights={liveRows} />

			{/* live protocol numbers, straight from the data facade */}
			<StatsTicker openMarkets={isDemo ? 0 : (routes?.length ?? 0)} />

			{/* THE DEPARTURES BOARD — signature artifact */}
			<section>
				<div className="board-head flex items-center justify-between border-2 border-b-0 border-line bg-raised px-4 py-3">
					<h2 className="h-section flex items-center gap-3">
						{!serious && (
							<span className="floaty inline-block">✈</span>
						)}
						{t.markets.boardTitle}
						<HowItWorksBubble />
					</h2>
					<span className="label-px hidden sm:block">
						{t.markets.boardHint}
						{!serious && <span className="blink">▊</span>}
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
							placeholder={t.markets.searchPlaceholder}
							value={query}
							onChange={(e) => {
								setQuery(e.target.value)
								setPage(0)
							}}
							aria-label={t.markets.searchAria}
						/>
					</div>
					<span className="label-px ml-auto">
						{t.markets.flightCount(filtered.length)}
						{scanning && (
							<span className="ml-2 text-sky">
								· {t.markets.scanning}
								<span className="blink">…</span>
							</span>
						)}
					</span>
				</div>

				<div
						className={`board-table-wrap relative overflow-x-auto border-2 border-line bg-inset ${
							filtered.length > 0 ? "" : "board-foot"
						}`}
					>
						<div className="scanlines absolute inset-0" />
					<table className="w-full min-w-[820px] border-collapse">
						<thead>
							<tr className="border-b-2 border-line text-left">
								{[
									t.markets.colFlight,
									t.markets.colRoute,
									t.markets.colDate,
									t.markets.colStatus,
									t.markets.colStake,
									"",
								].map((h, i) => (
									<th
										key={i}
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
											{t.markets.noMatch(query.trim().toUpperCase())}
										</span>
										<span className="mt-1 block font-body text-[13px] text-mute">
											{t.markets.noMatchHint}
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
										{t.markets.datePick}
									</td>
									<td className="px-4 py-3">
										<div className="flex flex-col items-start gap-1.5">
											{isDemo ? (
												<span className="status-px text-gold">
													{scanning
														? t.markets.statusScanning
														: t.markets.statusDemo}
												</span>
											) : (
												<span className="status-px text-win">
													{t.markets.statusBoarding}
												</span>
											)}
											<RiskBar
												flightId={route.flightId}
												route={`${route.origin}-${route.dest}`}
											/>
										</div>
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
												{t.markets.insureBtn(
													Number.parseFloat(
														oddsFor(route, defaults),
													),
												)}
											</button>
											<button
												type="button"
												onClick={() => void navigate("/house")}
												className="btn-px btn-win btn-sm row-yield"
												title={t.markets.yieldTitle}
											>
												{t.markets.yieldBtn}
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
					<div className="board-foot flex flex-wrap items-center justify-between gap-3 border-2 border-t-0 border-line bg-raised px-4 py-3">
						<span className="label-px">
							{t.markets.pageLabel(
								safePage + 1,
								pageCount,
								filtered.length,
							)}
						</span>
						<div className="flex items-center gap-3">
							<button
								type="button"
								className="page-btn"
								onClick={() => setPage(Math.max(0, safePage - 1))}
								disabled={safePage === 0}
								aria-label="Previous page"
							>
								{t.markets.pagePrev}
							</button>
							<span className="font-display text-[9px] tracking-[0.04em] text-ink">
								{t.markets.pageOf(safePage + 1, pageCount)}
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
								{t.markets.pageNext}
							</button>
						</div>
					</div>
				)}

				<p className="mt-3 font-body text-[13px] text-mute">
					<span className="font-semibold text-win">
						{t.markets.yieldExplainLead}
					</span>{" "}
					{t.markets.yieldExplain}
					{isDemo && !scanning && (
						<span className="ml-2 text-gold">
							{t.markets.demoNote}
						</span>
					)}
				</p>
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
