import { useState } from "react"
import { routeRisk } from "../data"
import { useTheme } from "../providers/ThemeProvider"

/**
 * Hover/focus explainer for the risk figure.
 *
 * The number needs a sentence next to it or it reads as a guess: it is a
 * seasonal PEAK for a 3-hour-plus delay, from a model trained on 15 million
 * real flights — three claims a bare "15%" makes none of. Hover-opened
 * (not click) because it is a reading aid, not an action, and focusable so
 * it is reachable without a mouse.
 */
function RiskExplainer({
	pct,
	vsBaseline,
	estimated,
	peak,
	children,
}: {
	pct: number
	vsBaseline?: number
	estimated: boolean
	/** figure is the year's peak (vs a single priced date) */
	peak: boolean
	children: React.ReactNode
}) {
	const [open, setOpen] = useState(false)
	return (
		<span
			className="riskbar-explain relative inline-flex"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			onFocus={() => setOpen(true)}
			onBlur={() => setOpen(false)}
			tabIndex={0}
			role="note"
			aria-label={`Delay risk explainer: up to ${pct} percent`}
		>
			{children}
			{open && (
				<span className="info-panel panel-raised riskbar-pop absolute bottom-full left-1/2 z-40 mb-2 block w-[19rem] max-w-[80vw] -translate-x-1/2 p-3 text-left normal-case tracking-normal">
					<span className="label-px mb-1.5 block text-gold">
						{peak ? "WORST MONTH" : "DELAY RISK"} · {pct}%
					</span>
					<span className="block font-body text-[12.5px] leading-relaxed text-dim">
						{estimated ? (
							<>
								An illustrative baseline — this route has no model
								probability yet.
							</>
						) : (
							<>
								{peak ? "In its " : "About "}
								{peak && (
									<>
										<span className="text-ink">worst month</span> of the year,
										about{" "}
									</>
								)}
								<span className="text-ink">{pct} in 100</span> of these
								flights land <span className="text-ink">3+ hours late</span>,
								get cancelled, or divert — the exact events this policy
								pays on.
								{vsBaseline !== undefined && (
									<>
										{" "}
										That is{" "}
										<span className="text-ink">{vsBaseline}×</span> the
										3.4% average across the whole network.
									</>
								)}{" "}
								{peak
									? "Quiet months run far lower, so this is the ceiling, not your date. "
									: "This is one representative date; other months differ. "}
								Learned from 15 million real BTS flights; storms on the day
								are priced separately.
							</>
						)}
					</span>
				</span>
			)}
		</span>
	)
}

/**
 * Horizontal delay-risk bar.
 *
 * Fed by the route's REAL model probability (`p_covered`) when the catalog
 * carries one. Because real values are small — roughly 0.4%–15% — the bar
 * is filled by how the route compares to the network baseline, not by the
 * raw percentage: a 10% route is three times the average and should look
 * alarming, but a 10%-wide bar would look almost empty.
 *
 * With no probability the bar renders an explicit "no data" state. It never
 * invents a number: an earlier version hashed the flight id into a
 * plausible-looking figure, which produced confident red readings up to 44%
 * — about triple anything this fleet can actually produce.
 *
 * Themed:
 *   FUN     = chunky segmented pixel bar (10 hard cells)
 *   SERIOUS = smooth rounded gradient bar
 */
export function RiskBar({
	flightId,
	route,
	pCovered,
	pCoveredIsPeak = false,
	compact = false,
	wide = false,
}: {
	flightId: string
	/** "ORIGIN-DEST", enables the static route table fallback. */
	route?: string
	/** Real model probability (0–1) from the catalog, when available. */
	pCovered?: number | null
	/** True when pCovered is the year's peak, not a single priced date. */
	pCoveredIsPeak?: boolean
	compact?: boolean
	/** Roomier bar for wide layouts (the board's status column). */
	wide?: boolean
}) {
	const { theme } = useTheme()
	const serious = theme === "serious"
	const { delayedPct, band, estimated, vsBaseline } = routeRisk(flightId, route, pCovered)

	const rootClass = wide ? "riskbar riskbar-wide" : "riskbar"

	if (delayedPct === null) {
		return (
			<div className={rootClass} title="No delay model available for this route yet.">
				<div className="riskbar-track riskbar-track-serious" />
				<span className="riskbar-value riskbar-nodata">—</span>
			</div>
		)
	}

	const color =
		band === "high"
			? "var(--color-loss)"
			: band === "med"
				? "var(--color-gold)"
				: "var(--color-win)"

	// Fill is relative to the baseline, capped at 3x = full bar. Raw percent
	// would make every honest value look like an empty bar.
	const fillPct = estimated
		? Math.min(100, delayedPct)
		: Math.min(100, Math.round(((vsBaseline ?? 0) / 3) * 100))

	// Short native title as the no-JS / screen-reader fallback; the hover
	// panel carries the full explanation.
	const title = estimated
		? `Illustrative delay risk ~${delayedPct}% — no model probability for this route.`
		: `Peak month: up to ${delayedPct}% of these flights are 3h+ late, cancelled or diverted.`

	// "up to" ONLY when the figure really is the year's ceiling. A staged
	// file priced before peaks were computed carries a single date, and
	// calling that "up to" would be a different lie from the one we removed.
	const peak = !estimated && pCoveredIsPeak
	const label = peak ? `up to ${delayedPct}%` : `${delayedPct}%`

	if (serious) {
		return (
			<div className={rootClass} title={title}>
				<div className="riskbar-track riskbar-track-serious">
					<div
						className="riskbar-fill-serious riskbar-fill-grow"
						style={{
							width: `${fillPct}%`,
							background: `linear-gradient(90deg, color-mix(in oklab, ${color} 73%, transparent), ${color})`,
						}}
					/>
				</div>
				<RiskExplainer pct={delayedPct} vsBaseline={vsBaseline} estimated={estimated} peak={peak}>
					<span className="riskbar-value riskbar-value-hint" style={{ color }}>
						{label}
					</span>
				</RiskExplainer>
				{!compact && estimated && <span className="riskbar-est">est.</span>}
			</div>
		)
	}

	// fun — 10 hard pixel cells, filled proportionally
	const cells = 10
	const filled = Math.round((fillPct / 100) * cells)
	return (
		<div className={rootClass} title={title}>
			<div className="riskbar-track-px" aria-hidden="true">
				{Array.from({ length: cells }, (_, i) => (
					<span
						key={i}
						className="riskbar-cell riskbar-cell-pop"
						style={{
							background: i < filled ? color : "var(--color-line)",
							animationDelay: `${i * 35}ms`,
						}}
					/>
				))}
			</div>
			<RiskExplainer pct={delayedPct} vsBaseline={vsBaseline} estimated={estimated} peak={peak}>
				<span className="riskbar-value riskbar-value-hint" style={{ color }}>
					{label}
				</span>
			</RiskExplainer>
			{!compact && estimated && <span className="riskbar-est">est.</span>}
		</div>
	)
}
