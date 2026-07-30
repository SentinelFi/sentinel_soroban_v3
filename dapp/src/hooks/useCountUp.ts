import { useEffect, useRef, useState } from "react"

/**
 * Animates an integer from its previous value up to `target` over
 * `durationMs`, via requestAnimationFrame. Used for the small whole-number
 * protocol stats (policies sold, open markets, insurances paid…) — not
 * worth the complexity for the USDC currency figures, which stay static.
 * Skips the animation entirely on `prefers-reduced-motion`.
 */
export function useCountUp(target: number, durationMs = 800): number {
	const [value, setValue] = useState(target)
	const fromRef = useRef(target)

	useEffect(() => {
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
			setValue(target)
			fromRef.current = target
			return
		}
		const from = fromRef.current
		if (from === target) return
		const start = performance.now()
		let raf = 0
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / durationMs)
			const eased = 1 - Math.pow(1 - t, 3)
			setValue(Math.round(from + (target - from) * eased))
			if (t < 1) raf = requestAnimationFrame(tick)
			else fromRef.current = target
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target])

	return value
}
