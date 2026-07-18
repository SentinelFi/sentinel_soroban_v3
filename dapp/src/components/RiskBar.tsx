import { routeRisk } from "../data"
import { useTheme } from "../providers/ThemeProvider"

/**
 * Horizontal delay-risk bar fed by the deterministic `routeRisk` estimate.
 * green (<25% delayed) → amber (<40%) → red (≥40%).
 *
 * The value is an ESTIMATE (see routeRisk) — the component renders a small
 * "est." tag and a title tooltip so it never implies measured history.
 *
 * Themed:
 *   FUN     = chunky segmented pixel bar (10 hard cells)
 *   SERIOUS = smooth rounded gradient bar
 */
export function RiskBar({
	flightId,
	route,
	compact = false,
}: {
	flightId: string
	/** "ORIGIN-DEST", enables the static route table lookup. */
	route?: string
	compact?: boolean
}) {
	const { theme } = useTheme()
	const serious = theme === "serious"
	const { delayedPct, band } = routeRisk(flightId, route)

	const color =
		band === "high"
			? "var(--color-loss)"
			: band === "med"
				? "var(--color-gold)"
				: "var(--color-win)"

	const title = `Estimated delay risk ≈ ${delayedPct}% (illustrative — no live route history on testnet)`

	if (serious) {
		return (
			<div className="riskbar" title={title}>
				<div className="riskbar-track riskbar-track-serious">
					<div
						className="riskbar-fill-serious"
						style={{
							width: `${delayedPct}%`,
							background: `linear-gradient(90deg, ${color}bb, ${color})`,
						}}
					/>
				</div>
				<span className="riskbar-value" style={{ color }}>
					{delayedPct}%
				</span>
				{!compact && <span className="riskbar-est">est.</span>}
			</div>
		)
	}

	// fun — 10 hard pixel cells, filled proportionally
	const cells = 10
	const filled = Math.round((delayedPct / 100) * cells)
	return (
		<div className="riskbar" title={title}>
			<div className="riskbar-track-px" aria-hidden="true">
				{Array.from({ length: cells }, (_, i) => (
					<span
						key={i}
						className="riskbar-cell"
						style={{
							background: i < filled ? color : "var(--color-line)",
						}}
					/>
				))}
			</div>
			<span className="riskbar-value" style={{ color }}>
				{delayedPct}%
			</span>
			{!compact && <span className="riskbar-est">est.</span>}
		</div>
	)
}
