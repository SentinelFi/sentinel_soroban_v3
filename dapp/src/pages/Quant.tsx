import { useDeferredValue, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { PixelArt } from "../components/PixelArt"
import { SeriousIcon } from "../components/SeriousIcon"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"

/**
 * MONTE CARLO SIMULATOR — upgrades the old deterministic underwriter
 * calculator with a distribution. Same four levers (+ a trials lever); each
 * trial samples the number of delayed flights from a Binomial(travelers,
 * 1 − onTime%) and tallies the pool net (premiums − payouts). We aggregate
 * thousands of trials into a histogram plus stat cards (median, mean/EV,
 * 5% VaR, P(profit)), and keep the honest deterministic readout + break-even.
 *
 * All math is pure JS with a SEEDED PRNG keyed to the inputs, so the
 * distribution is stable across renders and recomputes smoothly as a slider
 * drags (no unseeded Math.random reflow). Histogram is inline SVG — no chart
 * lib, small bundle.
 *
 * Themes differ structurally (fun pixel bars / arcade vs serious soft bars /
 * radar) via useTheme(); shared skeleton lives in wave2.css.
 */

/* ── seeded PRNG (mulberry32) ─────────────────────────────────────── */

function hashInputs(...nums: number[]): number {
	let h = 2166136261
	for (const n of nums) {
		// fold the number's bits in deterministically
		h ^= n & 0xffff
		h = Math.imul(h, 16777619)
		h ^= (n >>> 16) & 0xffff
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** ASCII minus — the pixel figure face has no U+2212 glyph. */
function usd(n: number): string {
	const rounded = Math.round(Math.abs(n))
	return `${n < 0 ? "-" : ""}$${rounded.toLocaleString()}`
}

/* ── one lever ────────────────────────────────────────────────────── */

function Slider({
	label,
	value,
	min,
	max,
	step = 1,
	onChange,
	readout,
}: {
	label: string
	value: number
	min: number
	max: number
	step?: number
	onChange: (v: number) => void
	readout: string
}) {
	const fill = ((value - min) / (max - min)) * 100
	return (
		<label className="block">
			<span className="mb-1 flex items-baseline justify-between gap-3">
				<span className="label-px">{label}</span>
				<span className="board-figure text-[24px]">{readout}</span>
			</span>
			<input
				type="range"
				className="slider-px"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				aria-label={label}
				style={{ "--fill": `${fill}%` } as React.CSSProperties}
			/>
			<span className="mt-1 flex justify-between font-body text-fine text-mute">
				<span>{min.toLocaleString()}</span>
				<span>{max.toLocaleString()}</span>
			</span>
		</label>
	)
}

/* ── stat card ────────────────────────────────────────────────────── */

function StatCard({
	label,
	value,
	note,
	tone,
}: {
	label: string
	value: string
	note: string
	tone: "ink" | "win" | "loss" | "gold"
}) {
	const color =
		tone === "win"
			? "text-win"
			: tone === "loss"
				? "text-loss"
				: tone === "gold"
					? "text-gold"
					: "text-ink"
	return (
		<div className="mc-stat min-w-0 overflow-hidden">
			<p className="label-px">{label}</p>
			<p
				className={`mt-1 board-figure text-[22px] leading-none whitespace-nowrap tabular-nums sm:text-[24px] ${color}`}
			>
				{value}
			</p>
			<p className="mt-1 font-body text-fine leading-snug text-mute">
				{note}
			</p>
		</div>
	)
}

/* ── monte-carlo core ─────────────────────────────────────────────── */

interface McResult {
	nets: number[]
	buckets: { x0: number; x1: number; count: number }[]
	median: number
	mean: number
	var5: number
	p95: number
	pProfit: number
	minNet: number
	maxNet: number
}

/**
 * Sample k ~ Binomial(n, p). Exact Bernoulli loop for small variance;
 * normal approximation (Box–Muller, continuity-corrected) once
 * n·p·(1−p) is large enough that the approximation is excellent —
 * making a trial O(1) instead of O(travelers), so the worst case drops
 * from runs×travelers (5M) RNG calls per slider tick to ~2×runs.
 */
function sampleBinomial(rng: () => number, n: number, p: number): number {
	if (n <= 0 || p <= 0) return 0
	if (p >= 1) return n
	const mean = n * p
	const variance = mean * (1 - p)
	if (variance > 9) {
		const u1 = rng() || Number.MIN_VALUE
		const u2 = rng()
		const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
		return Math.max(0, Math.min(n, Math.round(mean + z * Math.sqrt(variance))))
	}
	let k = 0
	for (let j = 0; j < n; j++) {
		if (rng() < p) k++
	}
	return k
}

function runMonteCarlo(
	travelers: number,
	onTimePct: number,
	uncertaintyPp: number,
	premium: number,
	payout: number,
	runs: number,
): McResult {
	const pDelay = 1 - onTimePct / 100
	const pSpread = uncertaintyPp / 100
	const premiums = travelers * premium
	// deterministic seed from all inputs → stable across renders
	const rng = mulberry32(
		hashInputs(travelers, onTimePct, uncertaintyPp, premium, payout, runs),
	)
	const nets: number[] = new Array(runs)
	for (let i = 0; i < runs; i++) {
		// parameter uncertainty: each month's true delay rate is itself
		// uncertain — draw p ~ Uniform(pDelay ± spread), clamped to [0, 1]
		// (from the yield_analysis Monte Carlo; spread 0 = old behaviour)
		const p = Math.min(
			1,
			Math.max(0, pDelay + (2 * rng() - 1) * pSpread),
		)
		const delayed = sampleBinomial(rng, travelers, p)
		nets[i] = premiums - delayed * payout
	}

	const sorted = [...nets].sort((a, b) => a - b)
	const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
	const median = pct(0.5)
	const mean = nets.reduce((s, v) => s + v, 0) / runs
	const var5 = pct(0.05)
	const p95 = pct(0.95)
	const pProfit = nets.filter((v) => v >= 0).length / runs
	const minNet = sorted[0]
	const maxNet = sorted[sorted.length - 1]

	// histogram — 21 buckets across the observed range (pad so no zero-width)
	const BUCKETS = 21
	const lo = Math.min(minNet, 0)
	const hi = Math.max(maxNet, 0)
	const span = hi - lo || 1
	const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
		x0: lo + (span * i) / BUCKETS,
		x1: lo + (span * (i + 1)) / BUCKETS,
		count: 0,
	}))
	for (const v of nets) {
		let idx = Math.floor(((v - lo) / span) * BUCKETS)
		if (idx < 0) idx = 0
		if (idx >= BUCKETS) idx = BUCKETS - 1
		buckets[idx].count++
	}

	return { nets, buckets, median, mean, var5, p95, pProfit, minNet, maxNet }
}

/* ── histogram (inline SVG) ───────────────────────────────────────── */

const HW = 640
const HH = 220
const HPAD = { l: 8, r: 8, t: 10, b: 26 }

function Histogram({ mc, serious }: { mc: McResult; serious: boolean }) {
	const t = useCopy()
	const maxCount = Math.max(...mc.buckets.map((b) => b.count), 1)
	const innerW = HW - HPAD.l - HPAD.r
	const innerH = HH - HPAD.t - HPAD.b
	const bw = innerW / mc.buckets.length
	const lo = mc.buckets[0].x0
	const hi = mc.buckets[mc.buckets.length - 1].x1
	const span = hi - lo || 1
	const zeroX = HPAD.l + ((0 - lo) / span) * innerW

	return (
		<svg
			className="mc-hist"
			viewBox={`0 0 ${HW} ${HH}`}
			role="img"
			aria-label="Histogram of simulated monthly net outcomes"
			shapeRendering={serious ? "geometricPrecision" : "crispEdges"}
		>
			{serious && (
				<defs>
					<linearGradient id="mc-win" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="var(--color-win)" stopOpacity="0.95" />
						<stop offset="100%" stopColor="var(--color-win)" stopOpacity="0.55" />
					</linearGradient>
					<linearGradient id="mc-loss" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="var(--color-loss)" stopOpacity="0.95" />
						<stop offset="100%" stopColor="var(--color-loss)" stopOpacity="0.55" />
					</linearGradient>
				</defs>
			)}

			{/* bars — green right of zero (profit), red left (loss) */}
			{mc.buckets.map((b, i) => {
				const h = (b.count / maxCount) * innerH
				const x = HPAD.l + i * bw
				const y = HPAD.t + innerH - h
				const profit = (b.x0 + b.x1) / 2 >= 0
				const fill = serious
					? profit
						? "url(#mc-win)"
						: "url(#mc-loss)"
					: profit
						? "var(--color-win)"
						: "var(--color-loss)"
				return (
					<rect
						key={i}
						className={serious ? "mc-bar-serious" : "mc-bar-fun"}
						x={x + (serious ? 1 : 0.5)}
						y={y}
						width={bw - (serious ? 2 : 1)}
						height={Math.max(h, b.count > 0 ? 2 : 0)}
						fill={fill}
						rx={serious ? 3 : 0}
					>
						<title>
							{usd(b.x0)} … {usd(b.x1)} · {b.count} months
						</title>
					</rect>
				)
			})}

			{/* break-even line at net = 0 */}
			<line
				className={serious ? "mc-breakeven-serious" : "mc-breakeven-fun"}
				x1={zeroX}
				x2={zeroX}
				y1={HPAD.t - 4}
				y2={HPAD.t + innerH}
			/>
			<text
				className="mc-axis-label"
				x={zeroX + 4}
				y={HPAD.t + 8}
			>
				{t.quant.breakEvenTick}
			</text>

			{/* x-axis min / max labels */}
			<text className="mc-axis-label" x={HPAD.l} y={HH - 8}>
				{usd(mc.minNet)}
			</text>
			<text
				className="mc-axis-label"
				x={HW - HPAD.r}
				y={HH - 8}
				textAnchor="end"
			>
				{usd(mc.maxNet)}
			</text>
		</svg>
	)
}

/* ── page ─────────────────────────────────────────────────────────── */

export default function Quant() {
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"

	const [travelers, setTravelers] = useState(100)
	const [onTimePct, setOnTimePct] = useState(80)
	const [uncertainty, setUncertainty] = useState(0)
	const [premium, setPremium] = useState(50)
	const [payout, setPayout] = useState(400)
	const [capital, setCapital] = useState(100000)
	const [runs, setRuns] = useState(2000)

	// deterministic readout (unchanged EV model)
	const premiums = travelers * premium
	const expectedPayouts = travelers * (1 - onTimePct / 100) * payout
	const net = premiums - expectedPayouts
	const breakEven = (1 - premium / payout) * 100

	// monte carlo — deferred inputs: the slider thumb and readouts update
	// at input priority while the simulation recomputes in a deferred
	// render, so dragging never janks even at the 5,000-trial setting
	const dTravelers = useDeferredValue(travelers)
	const dOnTimePct = useDeferredValue(onTimePct)
	const dUncertainty = useDeferredValue(uncertainty)
	const dPremium = useDeferredValue(premium)
	const dPayout = useDeferredValue(payout)
	const dRuns = useDeferredValue(runs)
	const mc = useMemo(
		() =>
			runMonteCarlo(
				dTravelers,
				dOnTimePct,
				dUncertainty,
				dPremium,
				dPayout,
				dRuns,
			),
		[dTravelers, dOnTimePct, dUncertainty, dPremium, dPayout, dRuns],
	)
	const yieldPct = (mc.mean / capital) * 100

	return (
		<div
			data-tour="calc"
			className="mx-auto max-w-5xl space-y-8 px-4 py-8"
		>
			<div>
				<Link
					to="/earn"
					className="font-body text-fine font-semibold tracking-[0.08em] text-sky hover:text-ink"
				>
					{t.quant.back}
				</Link>
				<h1 className="h-display mt-3 text-[22px] leading-[1.35] sm:text-[28px]">
					{t.quant.titleHead}{" "}
					<span className="text-gold">{t.quant.titleTail}</span>
				</h1>
				<p className="mt-3 max-w-2xl font-body text-body leading-relaxed text-dim">
					{t.quant.intro}
				</p>
			</div>

			<div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
				{/* levers */}
				<section className="panel space-y-6 p-5">
					<h2 className="h-section">{t.quant.levers}</h2>
					<Slider
						label={t.quant.leverTravelers}
						value={travelers}
						min={0}
						max={1000}
						onChange={setTravelers}
						readout={travelers.toLocaleString()}
					/>
					<Slider
						label={t.quant.leverOnTime}
						value={onTimePct}
						min={50}
						max={100}
						onChange={setOnTimePct}
						readout={`${onTimePct}%`}
					/>
					<Slider
						label={t.quant.leverUncertainty}
						value={uncertainty}
						min={0}
						max={15}
						onChange={setUncertainty}
						readout={`±${uncertainty}pp`}
					/>
					<Slider
						label={t.quant.leverPremium}
						value={premium}
						min={10}
						max={100}
						onChange={setPremium}
						readout={`$${premium}`}
					/>
					<Slider
						label={t.quant.leverPayout}
						value={payout}
						min={100}
						max={1000}
						step={10}
						onChange={setPayout}
						readout={`$${payout}`}
					/>
					<Slider
						label={t.quant.leverCapital}
						value={capital}
						min={10000}
						max={1000000}
						step={10000}
						onChange={setCapital}
						readout={usd(capital)}
					/>
					<Slider
						label={t.quant.leverRuns}
						value={runs}
						min={500}
						max={5000}
						step={500}
						onChange={setRuns}
						readout={runs.toLocaleString()}
					/>
				</section>

				{/* distribution */}
				<section className="space-y-5">
					<div className="panel-inset relative p-5">
						{!serious && (
							<div className="scanlines pointer-events-none absolute inset-0" />
						)}
						<div className="flex items-center justify-between gap-2">
							<h2 className="h-section flex items-center gap-2">
								{serious ? (
									<SeriousIcon
										name="trophy"
										className="h-5 w-5 text-highlight"
									/>
								) : (
									<PixelArt
										name="coin-usdc"
										icon
										className="h-6 w-6"
									/>
								)}
								{t.quant.distTitle}
							</h2>
							<span className="label-px">
								{t.quant.distSub(runs)}
							</span>
						</div>
						<div className="relative z-10 mt-4">
							<Histogram mc={mc} serious={serious} />
						</div>
					</div>

					{/* stat cards */}
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
						<StatCard
							label={t.quant.statMedian}
							value={usd(mc.median)}
							note={t.quant.statMeanNote}
							tone={mc.median >= 0 ? "win" : "loss"}
						/>
						<StatCard
							label={t.quant.statMean}
							value={usd(mc.mean)}
							note={t.quant.statMeanNote}
							tone={mc.mean >= 0 ? "win" : "loss"}
						/>
						<StatCard
							label={t.quant.statVar}
							value={usd(mc.var5)}
							note={t.quant.statVarNote}
							tone={mc.var5 >= 0 ? "ink" : "loss"}
						/>
						<StatCard
							label={t.quant.statP95}
							value={usd(mc.p95)}
							note={t.quant.statP95Note}
							tone={mc.p95 >= 0 ? "win" : "loss"}
						/>
						<StatCard
							label={t.quant.statProfit}
							value={`${Math.round(mc.pProfit * 100)}%`}
							note={t.quant.statProfitNote}
							tone={mc.pProfit >= 0.5 ? "win" : "gold"}
						/>
						<StatCard
							label={t.quant.statYield}
							value={`${yieldPct >= 0 ? "" : "-"}${Math.abs(yieldPct).toFixed(1)}%`}
							note={t.quant.statYieldNote}
							tone={yieldPct >= 0 ? "gold" : "loss"}
						/>
					</div>
				</section>
			</div>

			{/* deterministic readout — kept honest, break-even framing */}
			<section className="panel p-5">
				<h2 className="h-section">{t.quant.deterministicHead}</h2>
				<div className="mt-4 grid gap-4 sm:grid-cols-3">
					<div className="flex items-baseline justify-between sm:flex-col sm:items-start sm:gap-1">
						<span className="label-px">{t.quant.premiumsCollected}</span>
						<span className="font-board text-[26px] leading-none text-ink">
							{usd(premiums)}
						</span>
					</div>
					<div className="flex items-baseline justify-between sm:flex-col sm:items-start sm:gap-1">
						<span className="label-px">{t.quant.expectedPayouts}</span>
						<span className="font-board text-[26px] leading-none text-loss">
							{usd(-expectedPayouts)}
						</span>
					</div>
					<div className="flex items-baseline justify-between sm:flex-col sm:items-start sm:gap-1">
						<span className="label-px text-sky">{t.quant.netForPool}</span>
						<span
							className={`font-display text-[22px] ${
								net >= 0 ? "text-win" : "text-loss"
							}`}
						>
							{usd(net)}
						</span>
					</div>
				</div>
				<p className="mt-4 font-body text-meta font-semibold text-gold">
					{t.quant.breakEvenLabel(breakEven.toFixed(1))}
				</p>
				<p className="mt-1 font-body text-meta text-dim">
					{t.quant.avgNote}
				</p>
			</section>

			<p className="font-body text-meta text-mute">{t.quant.disclaimer}</p>
		</div>
	)
}
