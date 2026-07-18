import type { SharePricePoint } from "../data"

/**
 * Small share-price line chart over the snapshot days.
 *
 * Rendered IDENTICALLY in both themes — a smooth line with a soft gradient
 * area fill and a baseline axis. It only re-tints via the theme colour tokens
 * (--color-win / --color-line-mid); the shape and treatment are the same.
 *
 * Points are drawn edge-to-edge; the y-range is padded so a flat-ish series
 * still reads as a line rather than a bar at the floor.
 */
export function SharePriceChart({
	points,
	width = 320,
	height = 96,
}: {
	points: SharePricePoint[]
	width?: number
	height?: number
}) {
	if (!points || points.length < 2) return null

	const values = points.map((p) => p.price)
	const rawMin = Math.min(...values)
	const rawMax = Math.max(...values)
	const rangePad = (rawMax - rawMin || rawMax || 1) * 0.15
	const min = rawMin - rangePad
	const max = rawMax + rangePad
	const span = max - min || 1

	const padX = 4
	const padY = 8
	const w = width - padX * 2
	const h = height - padY * 2

	const pts = values.map((v, i) => {
		const x = padX + (i / (values.length - 1)) * w
		const y = padY + h - ((v - min) / span) * h
		return [x, y] as const
	})

	const line = pts
		.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
		.join(" ")

	const baseY = (height - padY).toFixed(1)
	const areaD = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${baseY} L${pts[0][0].toFixed(1)} ${baseY} Z`
	const stroke = "var(--color-win)"

	return (
		<svg
			className="w3-chart-svg"
			viewBox={`0 0 ${width} ${height}`}
			role="img"
			aria-label="Share price over time"
			preserveAspectRatio="none"
			shapeRendering="geometricPrecision"
		>
			<defs>
				<linearGradient id="w3-sp-grad" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={stroke} stopOpacity="0.24" />
					<stop offset="100%" stopColor={stroke} stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={areaD} fill="url(#w3-sp-grad)" stroke="none" />
			{/* baseline axis */}
			<line
				x1={padX}
				y1={baseY}
				x2={width - padX}
				y2={baseY}
				stroke="var(--color-line-mid)"
				strokeWidth={1}
			/>
			<path
				d={line}
				fill="none"
				stroke={stroke}
				strokeWidth={2}
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
		</svg>
	)
}
