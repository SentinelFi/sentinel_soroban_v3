import { useCopy } from "../copy"
import { useTheme } from "../providers/ThemeProvider"

/**
 * Trigger gauge — the board's visual for a route's delay threshold: an
 * 8-hour timeline where the dim leading cells are the tolerated wait and
 * the win-coloured tail is the payout zone (cover pays once the delay
 * crosses into it). Reuses the RiskBar track/cell/value classes so the
 * board's two gauges read as one family.
 *
 * Themed (same split as RiskBar):
 *   FUN     = chunky segmented pixel cells
 *   SERIOUS = smooth rounded bar, fill anchored to the right
 */
const SCALE_HOURS = 8

export function TriggerGauge({ hours }: { hours?: number }) {
	const t = useCopy()
	const { theme } = useTheme()
	if (hours === undefined) return <span className="text-mute">…</span>

	const zone = Math.max(SCALE_HOURS - Math.min(hours, SCALE_HOURS), 0)
	const title = t.markets.triggerTitle(hours)
	const label = `>${hours}h`

	if (theme === "serious") {
		return (
			<div className="riskbar" title={title}>
				<div className="riskbar-track-serious" style={{ display: "flex" }}>
					<div
						className="riskbar-fill-serious riskbar-fill-grow"
						style={{
							width: `${(zone / SCALE_HOURS) * 100}%`,
							marginLeft: "auto",
							background:
								"linear-gradient(90deg, color-mix(in oklab, var(--color-win) 55%, transparent), var(--color-win))",
						}}
					/>
				</div>
				<span
					className="riskbar-value"
					style={{ color: "var(--color-win)" }}
				>
					{label}
				</span>
			</div>
		)
	}

	return (
		<div className="riskbar" title={title}>
			<div className="riskbar-track-px" aria-hidden="true">
				{Array.from({ length: SCALE_HOURS }, (_, i) => (
					<span
						key={i}
						className="riskbar-cell riskbar-cell-pop"
						style={{
							background:
								i >= SCALE_HOURS - zone
									? "var(--color-win)"
									: "var(--color-line)",
							animationDelay: `${i * 35}ms`,
						}}
					/>
				))}
			</div>
			<span className="riskbar-value" style={{ color: "var(--color-win)" }}>
				{label}
			</span>
		</div>
	)
}
