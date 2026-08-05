import { Fragment, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import type { FlightData } from "oracle_aggregator"
import {
	controllerClient,
	governanceClient,
	formatUsdc,
	useActiveFlights,
	useActiveRoutes,
	useFlightDataBatch,
	useGovernanceDefaults,
	useIsWhitelisted,
	useWhitelistEnabled,
} from "../hooks/useContracts"
import type { UiRoute } from "../hooks/useContracts"
import { DEMO_ROUTES } from "../config/routes"
import { airlineName, flightradarSlug } from "../config/airlines"
import { useWallet } from "../hooks/useWallet"
import { useFlightSchedules } from "../hooks/useFlightSchedules"
import { utcHm } from "../lib/format"
import { stagedSigner, useTxFlow } from "../hooks/useTxFlow"
import { connectWallet } from "../util/wallet"
import { txHashOf } from "../lib/utils"
import { PixelArt } from "../components/PixelArt"
import { SeriousIcon } from "../components/SeriousIcon"
import { HowItWorksBubble } from "../components/InfoBubble"
import { TransactionButton } from "../components/TransactionButton"
import { TxProgress } from "../components/TxProgress"
import { RiskBar } from "../components/RiskBar"
import { ColumnInfo } from "../components/ColumnInfo"
import { FlightCalendar } from "../components/FlightCalendar"
import {
	routeRisk,
	TRACKED_MAP_LIMIT,
	useProtocolStats,
	useTotalAssets,
	useFreeCapital,
} from "../data"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"
import { useCountUp } from "../hooks/useCountUp"

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
 * flagged as DEMO on the board. DEMO_ROUTES (not CANDIDATE_ROUTES) so the
 * board still has something to show even if the fleet file itself is
 * momentarily empty (a fresh deploy before the first seed run).
 */
const SAMPLE_ROUTES: UiRoute[] = DEMO_ROUTES.map((route) => ({
	...route,
	status: "Active",
	terms: null,
}))

/** Default rows per page of the departures board. */
const BOARD_PAGE_SIZE = 12
/** Selectable page sizes — 12 stays the default. */
const BOARD_PAGE_SIZES = [12, 24, 48, 96]

/** Sortable board columns. */
type SortKey = "flight" | "status" | "stake"
type SortState = { key: SortKey; dir: 1 | -1 } | null

/**
 * Comparator for a sort key (ascending). Flight ids compare numerically
 * (AA9 before AA100); trigger compares by delay threshold, with rows whose
 * terms haven't resolved yet sorted last; status compares by the estimated
 * delay-risk value the row's RiskBar displays (routeRisk is deterministic,
 * so the order is stable); stake compares premium then payoff, with rows
 * still missing terms sorted last. Ties break by flight id.
 */
function compareRoutes(
	a: UiRoute,
	b: UiRoute,
	key: SortKey,
	defaults: Defaults | undefined,
): number {
	const byFlight = a.flightId.localeCompare(b.flightId, undefined, {
		numeric: true,
	})
	switch (key) {
		case "flight":
			return byFlight
		case "status": {
			// Routes with no model probability sort last rather than as 0%.
			const riskA = routeRisk(a.flightId, `${a.origin}-${a.dest}`, a.pCovered)
			const riskB = routeRisk(b.flightId, `${b.origin}-${b.dest}`, b.pCovered)
			const pa = riskA.delayedPct ?? -1
			const pb = riskB.delayedPct ?? -1
			return pa - pb || byFlight
		}
		case "stake": {
			const ta = termsFor(a, defaults)
			const tb = termsFor(b, defaults)
			if (ta.premium === undefined || tb.premium === undefined)
				return ta.premium === tb.premium
					? byFlight
					: ta.premium === undefined
						? 1
						: -1
			const byPremium = Number(ta.premium - tb.premium)
			const byPayoff = Number((ta.payoff ?? 0n) - (tb.payoff ?? 0n))
			return byPremium || byPayoff || byFlight
		}
	}
}

/** Render `text` with the word "delayed" carrying the loss accent — the
 *  fun hero's emphasis survives while the string itself lives in copy.ts. */
function EmphasizeDelayed({ text }: { text: string }) {
	const parts = text.split(/(delayed)/i)
	return (
		<>
			{parts.map((part, i) =>
				/^delayed$/i.test(part) ? (
					<span key={i} className="font-semibold text-loss">
						{part}
					</span>
				) : (
					<Fragment key={i}>{part}</Fragment>
				),
			)}
		</>
	)
}

/**
 * Serious-hero headline line rendered as split-flap letters. Each letter
 * carries a slice of one shared gradient — background-size spans the whole
 * line, offset per letter — so the clip reads as a single sweep while the
 * letters flip into place like an airport departure board. Screen readers
 * get the plain text once; the letters are decoration.
 *
 * `delayBase`/`delayStep` set the flip cadence — the fun hero runs a
 * quicker stagger than the serious one.
 */
function HeroFlapLine({
	text,
	delayBase = 240,
	delayStep = 50,
}: {
	text: string
	delayBase?: number
	delayStep?: number
}) {
	const letters = [...text]
	const n = letters.length
	return (
		<span className="hero-flap">
			<span className="sr-only">{text}</span>
			{letters.map((ch, i) => (
				<span
					key={i}
					aria-hidden="true"
					className="hero-flap-letter"
					style={{
						animationDelay: `${delayBase + i * delayStep}ms`,
						backgroundSize: `${n * 100}% 100%`,
						backgroundPosition:
							n > 1 ? `${(i / (n - 1)) * 100}% 0` : "0 0",
					}}
				>
					{ch === " " ? " " : ch}
				</span>
			))}
		</span>
	)
}

/**
 * External flight-tracking page. FR24 keys its flight pages by the IATA
 * flight number ("as462"), not the ICAO ident the fleet stores ("ASA462"),
 * so the ident must be converted first. Returns null when it cannot be
 * resolved — the caller renders plain text rather than a dead link.
 */
function flightradarUrl(flightId: string, carrier?: string | null): string | null {
	const slug = flightradarSlug(flightId, carrier)
	return slug
		? `https://www.flightradar24.com/data/flights/${encodeURIComponent(slug)}`
		: null
}

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
	const t = useCopy()
	const isDemo = liveFlights.length === 0
	// Capped like the globe, and for the same reason: the strip is an
	// ambient sample of what is in the air, not a manifest. Uncapped it
	// grows one chip per policy, which stretches the loop until any given
	// flight comes round every several minutes.
	const chips = !isDemo
		? liveFlights.slice(0, TRACKED_MAP_LIMIT).map((f) => ({
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

	// Hold the scroll SPEED constant instead of the loop time: the demo set
	// of 3 chips read well at 30s, so budget the same ~10s of travel per
	// chip. With the cap above, the loop tops out around 100s no matter how
	// many policies are live.
	const marqueeDur = `${Math.max(30, chips.length * 10)}s`

	return (
		<div className="ticker flex items-center gap-3 overflow-hidden border-2 border-line bg-inset py-2">
			<span className="z-10 flex shrink-0 items-center gap-2 border-r-2 border-line bg-inset pl-3 pr-3">
				<span
					className={`inline-block h-2 w-2 ${isDemo ? "blink bg-gold" : "breathe bg-win"}`}
				/>
				<span className={`label-px ${isDemo ? "text-gold" : "text-win"}`}>
					{isDemo ? t.markets.statusDemo : "LIVE"}
				</span>
			</span>
			{/* the 4× loop is presentational — screen readers get the
			    single-copy static list below instead, which also becomes
			    the visible wrapped layout under prefers-reduced-motion */}
			<div
				className="marquee-track gap-6"
				style={{ "--marquee-dur": marqueeDur } as React.CSSProperties}
				aria-hidden="true"
			>
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
			<ul className="ticker-static">
				{chips.map((chip, i) => (
					<li
						key={`${chip.code}-${i}`}
						className="flex items-center gap-2 whitespace-nowrap"
					>
						<span className="font-board text-[19px] text-ink">
							✈ {chip.code}
						</span>
						<span className={`status-px ${chip.status.color}`}>
							{chip.status.label}
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}

/* ── stats ticker (real protocol numbers) ───────────────────── */

interface PublicStats {
	flights_insured: number
	insurances_paid: number | null
	delayed_count: number | null
	cancelled_count: number | null
	total_paid_out: string
	db_available: boolean
	as_of: string
}

/** Sanitized chain + DB stats from the public `/api/status/stats` endpoint
 *  (DB-optional — insurances_paid/delayed_count/cancelled_count are null
 *  if the DB is unavailable, chain-only fields still answer). */
function usePublicStats() {
	return useQuery({
		queryKey: ["status", "stats"],
		queryFn: async () => {
			const res = await fetch("/api/status/stats")
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return (await res.json()) as PublicStats
		},
		refetchInterval: 60_000,
		retry: 1,
	})
}

/**
 * Scrolling strip of REAL, live protocol numbers pulled from the data facade
 * (TVL, free capital, premiums, travelers, open-markets count) plus the
 * sanitized public stats endpoint (insurances paid, delayed/cancelled
 * counts, total paid out). Same pixel marquee mechanic as the flight
 * ticker; the serious skin rounds the rail.
 */
function StatsTicker({ openMarkets }: { openMarkets: number }) {
	const t = useCopy()
	const { data: stats } = useProtocolStats()
	const { data: tvl } = useTotalAssets()
	const { data: free } = useFreeCapital()
	const { data: publicStats } = usePublicStats()

	// Whole-number counters animate up to their new value; currency figures
	// stay static (not worth the bigint-interpolation complexity).
	const policiesSoldCount = useCountUp(stats?.totalPoliciesSold ?? 0)
	const openMarketsCount = useCountUp(openMarkets)
	const insurancesPaidCount = useCountUp(publicStats?.insurances_paid ?? 0)
	const delayedCountUp = useCountUp(publicStats?.delayed_count ?? 0)
	const cancelledCountUp = useCountUp(publicStats?.cancelled_count ?? 0)

	const items: Array<{ key: string; label: string; value: string }> = [
		{
			key: "tvl",
			label: t.statsTicker.tvl,
			value: `${tvl != null ? formatUsdc(tvl) : "…"} USDC`,
		},
		{
			key: "free",
			label: t.statsTicker.free,
			value: `${free != null ? formatUsdc(free) : "…"} USDC`,
		},
		{
			key: "premiums",
			label: t.statsTicker.premiums,
			value: `${stats ? formatUsdc(stats.totalPremiumsCollected) : "…"} USDC`,
		},
		{
			key: "policies-sold",
			label: t.statsTicker.policiesSold,
			value: stats ? policiesSoldCount.toLocaleString() : "…",
		},
		{
			key: "open-markets",
			label: t.statsTicker.openMarkets,
			value: openMarketsCount.toLocaleString(),
		},
		{
			key: "paid-out",
			label: t.statsTicker.paidOut,
			value: publicStats
				? `${formatUsdc(BigInt(publicStats.total_paid_out))} USDC`
				: "…",
		},
		{
			key: "insurances-paid",
			label: t.statsTicker.insurancesPaid,
			value: !publicStats
				? "…"
				: (publicStats.insurances_paid != null ? insurancesPaidCount.toLocaleString() : "—"),
		},
		{
			key: "delayed",
			label: t.statsTicker.delayed,
			value: !publicStats
				? "…"
				: (publicStats.delayed_count != null ? delayedCountUp.toLocaleString() : "—"),
		},
		{
			key: "cancelled",
			label: t.statsTicker.cancelled,
			value: !publicStats
				? "…"
				: (publicStats.cancelled_count != null ? cancelledCountUp.toLocaleString() : "—"),
		},
	]

	const loop = [...items, ...items, ...items, ...items]

	return (
		<div
			data-testid="markets-stats"
			className="ticker flex items-center gap-3 overflow-hidden border-2 border-line bg-inset py-2"
		>
			<span className="z-10 flex shrink-0 items-center gap-2 border-r-2 border-line bg-inset pl-3 pr-3">
				<span className="label-px text-gold">{t.statsTicker.tag}</span>
			</span>
			<div className="marquee-track gap-8" aria-hidden="true">
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
			<ul className="ticker-static">
				{items.map((item) => (
					<li
						key={item.label}
						className="flex items-baseline gap-2 whitespace-nowrap"
					>
						<span className="label-px text-mute">{item.label}</span>
						<span
							data-testid={`markets-stat-${item.key}`}
							className="font-board text-[19px] text-ink"
						>
							{item.value}
						</span>
					</li>
				))}
			</ul>
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
	const { address, signTransaction, networkMismatch } = useWallet()
	const t = useCopy()
	const { theme } = useTheme()
	const [flightDate, setFlightDate] = useState("")
	// Scheduled departure (ISO) from the sale-auth response — the reliable
	// source, but it only lands mid-buy. Reset on date change.
	const [authDepIso, setAuthDepIso] = useState<string | null>(null)
	const flow = useTxFlow({
		invalidateKeys: [["controller"], ["usdc"]],
		// errors also go to a sticky toast — the inline stepper resets
		// itself, and users need time to read/copy what went wrong
		notifyError: true,
		onSettled: (outcome) => {
			if (outcome === "success") onClose()
		},
	})

	const { data: whitelistEnabled } = useWhitelistEnabled()
	const { data: isWhitelisted } = useIsWhitelisted(address)
	const whitelistBlocked =
		whitelistEnabled === true && !!address && isWhitelisted === false

	// Buy-time re-verification: board rows come from the cached /api/routes
	// catalog, so on open fire ONE `route_status` simulate for this route.
	// Not Active on-chain → block the buy; Active with different terms →
	// the chain's terms win below (the number the user pays must be the
	// chain's number). A failed simulate blocks nothing — sale-auth and the
	// contract still gate the actual purchase.
	const { data: liveStatus } = useQuery({
		queryKey: [
			"governance",
			"routeStatus",
			route.flightId,
			route.origin,
			route.dest,
		],
		queryFn: async () => {
			const tx = await governanceClient.route_status({
				flight_id: route.flightId,
				origin: route.origin,
				dest: route.dest,
			})
			return tx.result
		},
		staleTime: 30_000,
		retry: 1,
	})
	const routeUnavailable =
		liveStatus !== undefined && liveStatus.tag !== "Active"
	const liveTerms =
		liveStatus?.tag === "Active" ? liveStatus.values[0] : null

	// Scheduled departure for the picked day — opportunistic DB lookup of
	// the sale-auth snapshot (only exists once someone has authorized this
	// flight×date), upgraded to the live sale-auth answer during the buy.
	// Unknown → the row simply doesn't render; no billed API call either way.
	const dateSecs = flightDate ? dateStrToMidnightUtc(flightDate) : null
	const { data: schedMap } = useFlightSchedules(
		dateSecs !== null ? [{ flightId: route.flightId, date: dateSecs }] : [],
	)
	const authDepSecs = authDepIso ? Date.parse(authDepIso) / 1000 : NaN
	const depSecs = Number.isFinite(authDepSecs)
		? authDepSecs
		: dateSecs !== null
			? schedMap?.get(`${route.flightId}:${Number(dateSecs)}`)
			: undefined

	// Dialog behaviour: initial focus on the panel, Escape closes, Tab is
	// trapped inside, and focus returns to the opener on unmount — the
	// overlay is a real modal, not just a visual one.
	const panelRef = useRef<HTMLElement>(null)
	const onCloseRef = useRef(onClose)
	onCloseRef.current = onClose
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null
		panelRef.current?.focus()
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onCloseRef.current()
				return
			}
			if (e.key !== "Tab") return
			const panel = panelRef.current
			if (!panel) return
			const focusables = panel.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			)
			if (focusables.length === 0) return
			const first = focusables[0]
			const last = focusables[focusables.length - 1]
			const active = document.activeElement
			if (e.shiftKey && (active === first || active === panel)) {
				e.preventDefault()
				last.focus()
			} else if (!e.shiftKey && active === last) {
				e.preventDefault()
				first.focus()
			}
		}
		document.addEventListener("keydown", onKey)
		return () => {
			document.removeEventListener("keydown", onKey)
			opener?.focus()
		}
	}, [])

	const premium =
		liveTerms?.premium ?? route.terms?.premium ?? defaults?.default_premium
	const payoff =
		liveTerms?.payoff ?? route.terms?.payoff ?? defaults?.default_payoff
	const delayHours =
		liveTerms?.delay_hours ??
		route.terms?.delay_hours ??
		defaults?.default_delay_hours

	const placeBet = () => {
		if (!address || !flightDate || whitelistBlocked || routeUnavailable)
			return
		void flow.run(async (step) => {
			step("verifying")
			const date = dateStrToMidnightUtc(flightDate)
			const authRes = await fetch("/api/sale-auth/request", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ flight_id: route.flightId, date: Number(date) }),
			})
			// .catch: an HTML error page must surface as the HTTP error below,
			// not as a raw SyntaxError in the user-facing stepper.
			const auth = (await authRes.json().catch(() => ({}))) as {
				authorized?: boolean
				reason?: string
				error?: string
				scheduled_out?: string | null
			}
			if (!authRes.ok) {
				throw new Error(auth.error ?? "Sale authorization request failed")
			}
			if (!auth.authorized) {
				throw new Error(auth.reason ?? "Sale not authorized")
			}
			if (typeof auth.scheduled_out === "string") {
				setAuthDepIso(auth.scheduled_out)
			}

			// still "verifying" here — building/simulating is an RPC step;
			// stagedSigner flips to "awaiting" when the wallet actually opens
			const tx = await controllerClient.buy_insurance({
				traveler: address,
				flight_id: route.flightId,
				origin: route.origin,
				dest: route.dest,
				date,
			})
			const sent = await tx.signAndSend({
				signTransaction: stagedSigner(step, signTransaction),
			})
			return {
				message: t.notify.covered(route.flightId, flightDate),
				txHash: txHashOf(sent),
			}
		})
	}

	return createPortal(
		<div className="fixed inset-0 z-40 flex justify-end">
			{/* scrim */}
			<button
				type="button"
				aria-label={t.slip.closeAria}
				onClick={onClose}
				className="absolute inset-0 bg-page/85"
			/>
			<aside
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="betslip-title"
				data-testid="betslip"
				tabIndex={-1}
				className="slip-panel panel-raised relative z-10 flex h-full w-full max-w-[380px] flex-col gap-4 overflow-y-auto p-5"
			>
				<div className="flex items-start justify-between">
					<div>
						<p className="label-px text-gold">{t.slip.eyebrow}</p>
						<h2 id="betslip-title" className="h-display mt-1 text-[15px]">
							{t.slip.title}
						</h2>
					</div>
					<button
						type="button"
						data-testid="betslip-close"
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
							{t.slip.oddsLabel(
								oddsFor(
									liveTerms ? { ...route, terms: liveTerms } : route,
									defaults,
								),
							)}
						</span>
					</div>
					<p className="mt-2 font-body text-[14px] text-dim">
						<span className="font-board text-[20px] leading-none text-ink">
							{route.origin} ✈ {route.dest}
						</span>
					</p>
				</div>

				<div className="block">
					<span className="label-px mb-1 block">
						{t.slip.dateLabel}
					</span>
					<FlightCalendar
						value={flightDate}
						onChange={(d) => {
							setFlightDate(d)
							setAuthDepIso(null)
						}}
					/>
				</div>

				{/* perforation */}
				<div className="border-t-2 border-dashed border-line-mid" />

				<div className="space-y-2">
					{depSecs !== undefined && (
						<div className="flex items-center justify-between">
							<span className="label-px">{t.slip.departsLabel}</span>
							<span
								data-testid="betslip-departs"
								className="board-figure text-[18px] text-ink"
							>
								{utcHm(depSecs)}
							</span>
						</div>
					)}
					<div className="flex items-center justify-between">
						<span className="label-px">{t.slip.premiumLabel}</span>
						<span
							data-testid="betslip-premium"
							className="board-figure text-[22px] text-ink"
						>
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
					<div className="flex items-center justify-between">
						<span className="label-px">{t.slip.triggerLabel}</span>
						<span className="board-figure text-[18px] text-ink">
							{delayHours !== undefined
								? t.markets.triggerCell(delayHours)
								: "…"}
						</span>
					</div>
				</div>

				<TransactionButton
					state={flow.state}
					onClick={placeBet}
					disabled={
						!address ||
						!flightDate ||
						whitelistBlocked ||
						networkMismatch ||
						routeUnavailable
					}
					title={
						address && !flightDate ? t.slip.pickDateHint : undefined
					}
					className="btn-loss w-full"
					data-testid="betslip-buy"
				>
					{t.slip.cta(premium !== undefined ? formatUsdc(premium) : "…")}
				</TransactionButton>
				<TxProgress
					state={flow.state}
					steps={["verifying", "awaiting", "confirming"]}
					error={flow.error}
					stamps={{ success: "stamp-covered", fail: "stamp-denied" }}
					errorTestId="betslip-error"
				/>

				{routeUnavailable && flow.state === "idle" && (
					// Same testid the tx stepper stamps on its error line — the
					// guard above keeps the two from ever coexisting.
					<p
						data-testid="betslip-error"
						className="font-body text-[13px] text-loss"
					>
						{t.slip.unavailablePrompt}
					</p>
				)}
				{!address && (
					<div className="space-y-2">
						<p className="font-body text-[13px] text-gold">
							{t.slip.connectPrompt}
						</p>
						<button
							type="button"
							onClick={() => void connectWallet()}
							className="btn-px btn-gold btn-sm w-full"
						>
							{t.wallet.connect}
						</button>
					</div>
				)}
				{whitelistBlocked && (
					<p className="font-body text-[13px] text-gold">
						{t.slip.blockedPrompt}
					</p>
				)}

				<p className="mt-auto font-body text-[13px] leading-relaxed text-mute">
					{t.slip.fineprint}
				</p>
			</aside>
		</div>,
		document.body,
	)
}

/* ── page ────────────────────────────────────────────────────── */

export default function Markets() {
	const navigate = useNavigate()
	const [searchParams, setSearchParams] = useSearchParams()
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const [slipRoute, setSlipRoute] = useState<UiRoute | null>(null)
	const [query, setQuery] = useState("")
	const [page, setPage] = useState(0)
	const [pageSize, setPageSize] = useState(BOARD_PAGE_SIZE)
	const [sort, setSort] = useState<SortState>(null)

	const {
		data: routes,
		isLoading: routesLoading,
		isFetching: routesFetching,
	} = useActiveRoutes()
	const { data: defaults } = useGovernanceDefaults()
	const { data: activeFlights } = useActiveFlights()
	const { data: flightData } = useFlightDataBatch(activeFlights)

	// Never block the board on route loading: demo rows render immediately
	// and are swapped for live rows once the /api/routes catalog lands (one
	// shot) — or, on the chain-scan fallback, as chunks stream in (useRoutes
	// publishes partial results per chunk on the first scan).
	const isDemo = !routes || routes.length === 0
	const scanning = isDemo && (routesLoading || routesFetching)
	const displayRoutes = isDemo ? SAMPLE_ROUTES : routes

	// Deep-link from the Flight Map (/markets?flight=AA100): preselect the
	// row, open its slip, and set the search box so the row is visible.
	// The param is consumed on a match, or once the LIVE list has loaded
	// and genuinely lacks the flight — while the chunked chain scan is
	// still streaming, an unmatched param survives to the next pass so it
	// can't be spent against the DEMO sample.
	const deepLinkFlight = searchParams.get("flight")
	useEffect(() => {
		if (!deepLinkFlight) return
		const match = displayRoutes.find(
			(r) => r.flightId.toUpperCase() === deepLinkFlight.toUpperCase(),
		)
		if (!match && isDemo) return
		if (match) {
			setSlipRoute(match)
			setQuery(match.flightId)
			setPage(0)
		}
		searchParams.delete("flight")
		setSearchParams(searchParams, { replace: true })
	}, [deepLinkFlight, displayRoutes, isDemo, searchParams, setSearchParams])

	// The on-chain active set only drops a flight once the daily prune_settled
	// sweep runs, so a Settled or already-claimable (ToBeSettledDelayed)
	// flight can sit in `activeFlights` for up to ~24h. Filter both out here
	// (same rule useTrackedFlights uses for the globe) so the "LIVE" ticker
	// never shows a flight whose outcome is already fully resolved.
	const liveRows = (flightData ?? [])
		.filter((f) => {
			const tag = f.data?.status.tag
			return tag !== "Settled" && tag !== "ToBeSettledDelayed"
		})
		.map((f) => ({
			flightId: f.flightId,
			date: f.date,
			tag: f.data ? f.data.status.tag : null,
		}))

	// Top horizontal scrollbar for the board: a thin rail above the table
	// mirroring the wrap's scrollWidth, kept in sync both ways so either
	// bar drags the table. Only rendered while the board actually
	// overflows (narrow screens).
	const boardScrollRef = useRef<HTMLDivElement>(null)
	const topScrollRef = useRef<HTMLDivElement>(null)
	const [boardScrollWidth, setBoardScrollWidth] = useState(0)
	const [boardOverflows, setBoardOverflows] = useState(false)
	useEffect(() => {
		const el = boardScrollRef.current
		if (!el) return
		const update = () => {
			setBoardScrollWidth(el.scrollWidth)
			setBoardOverflows(el.scrollWidth > el.clientWidth + 1)
		}
		update()
		const ro = new ResizeObserver(update)
		ro.observe(el)
		const table = el.querySelector("table")
		if (table) ro.observe(table)
		return () => ro.disconnect()
	}, [])
	const syncFromBoard = () => {
		if (topScrollRef.current && boardScrollRef.current)
			topScrollRef.current.scrollLeft = boardScrollRef.current.scrollLeft
	}
	const syncFromTop = () => {
		if (topScrollRef.current && boardScrollRef.current)
			boardScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft
	}

	// Header click cycles ascending → descending → back to board order.
	const toggleSort = (key: SortKey) => {
		setPage(0)
		setSort((prev) =>
			prev?.key !== key
				? { key, dir: 1 }
				: prev.dir === 1
					? { key, dir: -1 }
					: null,
		)
	}

	// Search-first board: with 100s of whitelisted flights a raw list is
	// unusable — filter by flight number or airport code across ALL rows,
	// sort if a column is active, then page the results (search resets to
	// page 1).
	const filtered = displayRoutes.filter((route) =>
		matchesQuery(route, query),
	)
	const sorted = sort
		? [...filtered].sort(
				(a, b) => compareRoutes(a, b, sort.key, defaults) * sort.dir,
			)
		: filtered
	const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
	const safePage = Math.min(page, pageCount - 1)
	const visible = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize)

	return (
		<div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
			{serious ? (
				/* serious hero — oversized fluid Outfit headline over the canvas
				   flight-paths: line 1 rises in and gets a periodic sheen sweep,
				   line 2 flips in split-flap style with a breathing gradient.
				   All motion is disabled under prefers-reduced-motion. */
				<section className="hero-serious relative py-10 sm:py-16">
					<h1 className="hero-serious-title hero-mega font-display font-bold leading-[1.02]">
						<span className="hero-line1">{t.markets.heroLine1}</span>
						<br />
						<HeroFlapLine text={t.markets.heroLine2} />
					</h1>
					<p className="hero-sub-rise mt-6 max-w-xl font-body text-[16px] leading-relaxed text-dim sm:text-[18px]">
						{t.markets.heroSub}
					</p>
					<div className="hero-sub-rise mt-8 flex flex-wrap items-center gap-3">
						<button
							type="button"
							className="btn-px btn-gold hero-cta"
							onClick={() =>
								document
									.querySelector('[data-tour="board"]')
									?.scrollIntoView({ block: "start" })
							}
						>
							{t.markets.heroCtaBoard}
						</button>
					</div>
				</section>
			) : (
				/* fun hero — headline row, then a full-width night-airfield band.
				    The band keeps the art's exact 400:148 aspect so the runway
				    line stays put at every width; the plane lands on it. */
				<section>
					<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
						<h1 className="h-display text-[24px] leading-[1.45] sm:text-[32px]">
							<span className="hero-fun-line1">
								{t.markets.heroLine1}
							</span>
							<br />
							<span className="text-loss">
								<HeroFlapLine
									text={t.markets.heroLine2}
									delayBase={120}
									delayStep={26}
								/>
							</span>
						</h1>
						<p className="hero-sub-rise max-w-sm font-body text-[15px] leading-relaxed text-dim">
							<EmphasizeDelayed text={t.markets.heroSub} />
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

			{/* THE DEPARTURES BOARD — signature artifact. scroll-mt keeps the
			    board head clear of the sticky top bar when the hero CTA (or a
			    hash link) scrolls to it. */}
			<section data-tour="board" className="scroll-mt-24">
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
							data-testid="board-search"
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

				{/* top scrollbar — mirrors the table's horizontal overflow so
					    narrow screens get a scroll handle above the board too */}
					{boardOverflows && (
						<div
							ref={topScrollRef}
							onScroll={syncFromTop}
							aria-hidden="true"
							className="overflow-x-auto overflow-y-hidden border-2 border-b-0 border-line bg-surface"
						>
							<div
								style={{ width: boardScrollWidth }}
								className="h-px"
							/>
						</div>
					)}

					<div
						ref={boardScrollRef}
						onScroll={syncFromBoard}
						className={`board-table-wrap relative overflow-x-auto border-2 border-line bg-inset ${
							filtered.length > 0 ? "" : "board-foot"
						}`}
					>
						<div className="scanlines absolute inset-0" />
					<table
						data-testid="markets-board"
						className="w-full min-w-[700px] border-collapse"
					>
						<thead>
							<tr className="border-b-2 border-line text-left">
								{(
									[
										{ label: t.markets.colFlight, key: "flight" },
										{ label: t.markets.colRoute },
										{
											label: t.markets.colStatus,
											key: "status",
											info: (
												<ColumnInfo title="DELAY RISK">
													The percentage is this route&rsquo;s modelled
													chance of a payout: the flight lands{" "}
													<span className="text-ink">3+ hours late</span>,
													is cancelled, or diverts. Learned from{" "}
													<span className="text-ink">
														15 million real BTS flights
													</span>{" "}
													&mdash; carrier, route, month and time of day,
													never the flight number. The bar is scaled
													against the{" "}
													<span className="text-ink">3.4% network
													average</span>, so a full bar is roughly three
													times typical rather than 100%. Same-day storms
													are priced separately, in the premium.
												</ColumnInfo>
											),
										},
										{
											label: t.markets.colStake,
											key: "stake",
											info: (
												<ColumnInfo title="PREMIUM AND PAYOUT">
													You pay the premium once; if the flight is 3+
													hours late, cancelled or diverted you claim the
													payout in full. Payout is fixed at{" "}
													<span className="text-ink">100 USDC</span>.
													Premium is the model&rsquo;s probability times
													that payout, plus a{" "}
													<span className="text-ink">30% margin</span> for
													the underwriters, rounded up to whole dollars
													and floored at{" "}
													<span className="text-ink">$10</span>. Above a
													$20 base we decline the route rather than sell
													it at a known loss. Severe weather on your date
													adds a surcharge on top, capped at $30 total.
													The number you pay is always the chain&rsquo;s,
													re-checked when you open the slip.
												</ColumnInfo>
											),
										},
										{ label: "" },
									] as Array<{
										label: string
										key?: SortKey
										info?: React.ReactNode
									}>
								).map((col, i) => (
									<th
										key={i}
										className="label-px px-4 py-2 font-normal"
										aria-sort={
											col.key && sort?.key === col.key
												? sort.dir === 1
													? "ascending"
													: "descending"
												: undefined
										}
									>
										{col.key ? (
											<button
												type="button"
												onClick={() => toggleSort(col.key!)}
												className="label-px relative z-10 inline-flex items-center gap-1.5 cursor-pointer hover:text-ink"
												aria-label={t.markets.sortAria(col.label)}
											>
												{col.label}
												<span
													aria-hidden="true"
													className={
														sort?.key === col.key
															? "text-sky"
															: "text-mute/50"
													}
												>
													{sort?.key === col.key
														? sort.dir === 1
															? "▲"
															: "▼"
														: "↕"}
												</span>
											</button>
										) : (
											col.label
										)}
										{col.info ? (
											<span className="ml-1.5 inline-flex">{col.info}</span>
										) : null}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{filtered.length === 0 && (
								<tr>
									<td colSpan={5} className="px-4 py-10 text-center">
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
									data-testid="board-row"
									data-flight-id={route.flightId}
									className="board-row-in border-b-2 border-line/60 hover:bg-raised/60"
								>
									<td className="px-4 py-3">
										{(() => {
											const fr = flightradarUrl(
												route.flightId,
												route.carrier,
											)
											return fr ? (
												<a
													href={fr}
													target="_blank"
													rel="noopener noreferrer"
													title={t.markets.flightLinkTitle(
														route.flightId,
													)}
													className="board-figure relative z-10 hover:text-sky hover:underline"
												>
													{route.flightId}
												</a>
											) : (
												<span className="board-figure relative z-10">
													{route.flightId}
												</span>
											)
										})()}
									</td>
									<td
										className="px-4 py-3 font-body text-[14px] font-semibold tracking-[0.04em] text-ink"
										title={airlineName(route.flightId, route.carrier)}
									>
										{route.origin} → {route.dest}
									</td>
									<td className="px-4 py-3">
										<div className="flex flex-col items-start gap-1.5">
											{isDemo ? (
												<span
													key={scanning ? "scan" : "demo"}
													data-testid="board-row-status"
													className="status-px status-flap text-gold"
												>
													{scanning
														? t.markets.statusScanning
														: t.markets.statusDemo}
												</span>
											) : (
												<span
													key="boarding"
													data-testid="board-row-status"
													className="status-px status-flap text-win"
												>
													{t.markets.statusBoarding}
												</span>
											)}
											<RiskBar
												flightId={route.flightId}
												route={`${route.origin}-${route.dest}`}
												pCovered={route.pCovered}
												pCoveredIsPeak={route.pCoveredIsPeak}
												wide
											/>
										</div>
									</td>
									<td className="px-4 py-3 whitespace-nowrap">
										{(() => {
											const { premium, payoff } = termsFor(
												route,
												defaults,
											)
											const fmtPremium =
												premium !== undefined
													? formatUsdc(premium)
													: "…"
											const fmtPayoff =
												payoff !== undefined
													? formatUsdc(payoff)
													: "…"
											return (
												<span
													title={t.markets.stakeTitle(
														fmtPremium,
														fmtPayoff,
													)}
													className="font-body text-[14px] font-semibold"
												>
													<span className="text-ink">
														{fmtPremium}
													</span>
													<span className="mx-1 font-normal text-mute">
														→
													</span>
													<span className="text-win">
														{fmtPayoff}
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
											{(() => {
												const odds = Number.parseFloat(
													oddsFor(route, defaults),
												)
												return (
													<button
														type="button"
														data-testid="board-row-buy"
														onClick={() => setSlipRoute(route)}
														className="btn-px btn-loss btn-sm row-insure"
														title={t.markets.insureTitle(odds)}
													>
														{t.markets.insureBtn(odds)}
													</button>
												)
											})()}
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
						<div className="flex flex-wrap items-center gap-3">
							<span className="label-px">
								{t.markets.pageLabel(
									safePage + 1,
									pageCount,
									filtered.length,
								)}
							</span>
							<label className="flex items-center gap-2">
								<span className="label-px">{t.markets.perPage}</span>
								<select
									className="field-px w-auto px-2 py-1 text-[13px]"
									value={pageSize}
									onChange={(e) => {
										setPageSize(Number(e.target.value))
										setPage(0)
										// drop focus so the field's focus border
										// doesn't linger after picking a value
										e.currentTarget.blur()
									}}
									aria-label={t.markets.perPageAria}
								>
									{BOARD_PAGE_SIZES.map((n) => (
										<option key={n} value={n}>
											{n}
										</option>
									))}
								</select>
							</label>
						</div>
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
