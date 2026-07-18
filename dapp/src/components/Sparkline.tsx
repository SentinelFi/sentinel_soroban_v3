import { useTheme } from "../providers/ThemeProvider"

/**
 * Tiny inline SVG sparkline from a number[]. Returns null for <2 points.
 *
 * Themed:
 *   FUN     = hard 1px stepped stroke (no smoothing), no fill
 *   SERIOUS = smooth soft stroke + faint area fill under the line
 */
export function Sparkline({
	data,
	width = 96,
	height = 28,
	color,
	className,
}: {
	data: number[]
	width?: number
	height?: number
	/** stroke colour; defaults to the win accent. */
	color?: string
	className?: string
}) {
	const { theme } = useTheme()
	const serious = theme === "serious"

	if (!data || data.length < 2) return null

	const min = Math.min(...data)
	const max = Math.max(...data)
	const span = max - min || 1
	const pad = 2
	const w = width - pad * 2
	const h = height - pad * 2

	const pts = data.map((v, i) => {
		const x = pad + (i / (data.length - 1)) * w
		const y = pad + h - ((v - min) / span) * h
		return [x, y] as const
	})

	const stroke = color ?? "var(--color-win)"

	// fun = stepped (H then V between points); serious = straight line segments
	let d: string
	if (serious) {
		d = pts
			.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
			.join(" ")
	} else {
		d = pts
			.map(([x, y], i) => {
				if (i === 0) return `M${x.toFixed(1)} ${y.toFixed(1)}`
				const [px] = pts[i - 1]
				return `H${((px + x) / 2).toFixed(1)} V${y.toFixed(1)} H${x.toFixed(1)}`
			})
			.join(" ")
	}

	const areaD = serious
		? `${d} L${pts[pts.length - 1][0].toFixed(1)} ${(height - pad).toFixed(1)} L${pts[0][0].toFixed(1)} ${(height - pad).toFixed(1)} Z`
		: ""

	const gradId = `spark-${Math.abs(hashPts(pts))}`

	return (
		<svg
			className={className}
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			role="img"
			aria-hidden="true"
			shapeRendering={serious ? "geometricPrecision" : "crispEdges"}
		>
			{serious && (
				<>
					<defs>
						<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
							<stop offset="100%" stopColor={stroke} stopOpacity="0" />
						</linearGradient>
					</defs>
					<path d={areaD} fill={`url(#${gradId})`} stroke="none" />
				</>
			)}
			<path
				d={d}
				fill="none"
				stroke={stroke}
				strokeWidth={serious ? 1.75 : 1.5}
				strokeLinejoin={serious ? "round" : "miter"}
				strokeLinecap={serious ? "round" : "butt"}
			/>
		</svg>
	)
}

function hashPts(pts: ReadonlyArray<readonly [number, number]>): number {
	let h = 0
	for (const [x, y] of pts) h = (h * 31 + Math.round(x * 7 + y * 13)) | 0
	return h
}
