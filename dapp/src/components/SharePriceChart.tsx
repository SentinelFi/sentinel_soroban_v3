import { useRef, useState } from "react"
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
 *
 * Hovering (or touch-dragging) snaps a crosshair to the nearest snapshot
 * and shows its UTC date + share price. The SVG is stretched to the card
 * (preserveAspectRatio="none"), so pointer position maps to a point index
 * via fractions of the wrapper width, not SVG pixels.
 */

// each point's `day` is a unix epoch-day (see useSharePriceSeries)
const dateFmt = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
})

export function SharePriceChart({
	points,
	width = 320,
	height = 96,
}: {
	points: SharePricePoint[]
	width?: number
	height?: number
}) {
	const [hover, setHover] = useState<number | null>(null)
	const wrapRef = useRef<HTMLDivElement>(null)

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

	const onPointerMove = (e: React.PointerEvent) => {
		const rect = wrapRef.current?.getBoundingClientRect()
		if (!rect || rect.width === 0) return
		// wrapper-x fraction → viewBox x → nearest point index
		const vx = ((e.clientX - rect.left) / rect.width) * width
		const i = Math.round(((vx - padX) / w) * (values.length - 1))
		setHover(Math.max(0, Math.min(values.length - 1, i)))
	}

	const hovered = hover != null ? points[hover] : null
	const hx = hover != null ? pts[hover][0] : 0
	const hy = hover != null ? pts[hover][1] : 0
	// anchor the tooltip so it never sticks out past the chart's edges
	const xFrac = hx / width
	const tipShift =
		xFrac < 0.15 ? "0%" : xFrac > 0.85 ? "-100%" : "-50%"

	return (
		<div
			ref={wrapRef}
			className="relative"
			onPointerMove={onPointerMove}
			onPointerLeave={() => setHover(null)}
		>
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
				{hover != null && (
					<>
						<line
							x1={hx}
							y1={padY}
							x2={hx}
							y2={height - padY}
							stroke="var(--color-line-strong)"
							strokeWidth={1}
							strokeDasharray="3 3"
							vectorEffect="non-scaling-stroke"
						/>
						<circle
							cx={hx}
							cy={hy}
							r={3}
							fill={stroke}
							stroke="var(--color-page)"
							strokeWidth={1}
						/>
					</>
				)}
			</svg>
			{hovered && (
				<div
					className="pointer-events-none absolute z-10 border border-line-mid bg-raised px-2 py-1 whitespace-nowrap"
					style={{
						left: `${(xFrac * 100).toFixed(2)}%`,
						top: `${((hy / height) * 100).toFixed(2)}%`,
						transform: `translate(${tipShift}, calc(-100% - 8px))`,
					}}
				>
					<span className="font-body text-[11px] text-mute">
						{dateFmt.format(new Date(hovered.day * 86_400_000))} ·{" "}
					</span>
					<span className="font-body text-[11px] font-bold text-ink">
						{hovered.price.toFixed(4)} USDC
					</span>
				</div>
			)}
		</div>
	)
}
