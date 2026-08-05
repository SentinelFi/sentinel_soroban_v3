import { routeRisk } from "../data"
import { useTheme } from "../providers/ThemeProvider"

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
	compact = false,
	wide = false,
}: {
	flightId: string
	/** "ORIGIN-DEST", enables the static route table fallback. */
	route?: string
	/** Real model probability (0–1) from the catalog, when available. */
	pCovered?: number | null
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

	const title = estimated
		? `Illustrative delay risk ≈ ${delayedPct}% — no model probability for this route.`
		: `Modelled chance of a payout: ${delayedPct}% (${vsBaseline}x the network average of 3.4%). ` +
			`Covers arrival 3h+ late, cancelled or diverted.`

	const label = `${delayedPct}%`

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
				<span className="riskbar-value" style={{ color }}>
					{label}
				</span>
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
			<span className="riskbar-value" style={{ color }}>
				{label}
			</span>
			{!compact && estimated && <span className="riskbar-est">est.</span>}
		</div>
	)
}
