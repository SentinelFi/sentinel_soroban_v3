import { useEffect, useRef } from "react"

interface FlightPath {
	// Cubic bezier control points
	p0: { x: number; y: number }
	p1: { x: number; y: number }
	p2: { x: number; y: number }
	p3: { x: number; y: number }
	t: number
	speed: number
	opacity: number
	size: number
	trailCount: number
}

function generatePath(w: number, h: number): FlightPath {
	return {
		p0: { x: -50, y: Math.random() * h },
		p1: { x: w * 0.25 + (Math.random() - 0.5) * w * 0.3, y: Math.random() * h },
		p2: { x: w * 0.75 + (Math.random() - 0.5) * w * 0.3, y: Math.random() * h },
		p3: { x: w + 50, y: Math.random() * h },
		t: Math.random(),
		speed: 0.0004 + Math.random() * 0.0003,
		opacity: 0.06 + Math.random() * 0.06,
		size: 10 + Math.random() * 8,
		trailCount: 20 + Math.floor(Math.random() * 15),
	}
}

/** Evaluate cubic bezier at parameter t */
function bezierPoint(
	p0: number, p1: number, p2: number, p3: number, t: number,
): number {
	const u = 1 - t
	return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/** Evaluate cubic bezier tangent (derivative) at parameter t */
function bezierTangent(
	p0: number, p1: number, p2: number, p3: number, t: number,
): number {
	const u = 1 - t
	return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2)
}

const PLANE_COLOR = "#3a6bff"
const TRAIL_DOT_SPACING = 0.008

function drawPlane(
	ctx: CanvasRenderingContext2D,
	x: number, y: number,
	angle: number,
	s: number,
	opacity: number,
) {
	ctx.save()
	ctx.translate(x, y)
	ctx.rotate(angle)
	ctx.globalAlpha = opacity
	ctx.fillStyle = PLANE_COLOR

	ctx.beginPath()

	// Fuselage — 3 quadratic curves forming a tapered body
	ctx.moveTo(s * 1.3, 0)
	ctx.quadraticCurveTo(s * 0.5, -s * 0.18, -s * 1.0, -s * 0.08)
	ctx.quadraticCurveTo(-s * 1.2, 0, -s * 1.0, s * 0.08)
	ctx.quadraticCurveTo(s * 0.5, s * 0.18, s * 1.3, 0)

	// Top wing — trapezoid
	ctx.moveTo(s * 0.15, -s * 0.05)
	ctx.lineTo(-s * 0.3, -s * 0.85)
	ctx.lineTo(-s * 0.6, -s * 0.85)
	ctx.lineTo(-s * 0.15, -s * 0.05)

	// Bottom wing — mirrored
	ctx.moveTo(s * 0.15, s * 0.05)
	ctx.lineTo(-s * 0.3, s * 0.85)
	ctx.lineTo(-s * 0.6, s * 0.85)
	ctx.lineTo(-s * 0.15, s * 0.05)

	// Tail fin — small triangle
	ctx.moveTo(-s * 0.85, -s * 0.04)
	ctx.lineTo(-s * 1.1, -s * 0.4)
	ctx.lineTo(-s * 1.2, -s * 0.38)
	ctx.lineTo(-s * 0.95, 0)

	ctx.fill()
	ctx.restore()
}

export function FlightBackground() {
	const canvasRef = useRef<HTMLCanvasElement>(null)

	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return

		const ctx = canvas.getContext("2d")
		if (!ctx) return

		let animationId: number
		let paths: FlightPath[] = []

		// Respect reduced-motion: paint ONE static frame of the flight paths
		// (content/atmosphere stays visible) and skip the rAF loop entirely.
		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches

		function resize() {
			if (!canvas) return
			canvas.width = window.innerWidth
			canvas.height = window.innerHeight
			paths = Array.from({ length: 5 }, () =>
				generatePath(canvas.width, canvas.height),
			)
			if (reduceMotion) {
				// seed each path partway so a full scene shows, then paint once
				for (const path of paths) path.t = 0.35 + Math.random() * 0.3
				draw(false)
			}
		}

		function draw(advance: boolean) {
			if (!ctx || !canvas) return
			ctx.clearRect(0, 0, canvas.width, canvas.height)

			for (const path of paths) {
				if (advance) {
					path.t += path.speed
					if (path.t >= 1) {
						Object.assign(
							path,
							generatePath(canvas.width, canvas.height),
						)
						path.t = 0
					}
				}

				const { p0, p1, p2, p3, t, size, opacity, trailCount } = path

				// Draw trail dots behind the plane
				for (let i = trailCount; i >= 1; i--) {
					const dt = t - i * TRAIL_DOT_SPACING
					if (dt < 0) continue

					const dx = bezierPoint(p0.x, p1.x, p2.x, p3.x, dt)
					const dy = bezierPoint(p0.y, p1.y, p2.y, p3.y, dt)

					// Fade both opacity and radius for older dots
					const fade = 1 - i / trailCount
					const dotRadius = 1.5 * fade + 0.5
					const dotOpacity = opacity * fade * 0.6

					ctx.beginPath()
					ctx.arc(dx, dy, dotRadius, 0, Math.PI * 2)
					ctx.fillStyle = PLANE_COLOR
					ctx.globalAlpha = dotOpacity
					ctx.fill()
				}

				// Current plane position
				const px = bezierPoint(p0.x, p1.x, p2.x, p3.x, t)
				const py = bezierPoint(p0.y, p1.y, p2.y, p3.y, t)

				// Direction from tangent vector
				const tx = bezierTangent(p0.x, p1.x, p2.x, p3.x, t)
				const ty = bezierTangent(p0.y, p1.y, p2.y, p3.y, t)
				const angle = Math.atan2(ty, tx)

				drawPlane(ctx, px, py, angle, size, opacity)
			}

			ctx.globalAlpha = 1
			if (advance) animationId = requestAnimationFrame(() => draw(true))
		}

		resize()
		window.addEventListener("resize", resize)

		if (!reduceMotion) draw(true)

		return () => {
			window.removeEventListener("resize", resize)
			cancelAnimationFrame(animationId)
		}
	}, [])

	return (
		<canvas
			ref={canvasRef}
			className="pointer-events-none fixed inset-0 z-0 opacity-80"
		/>
	)
}
