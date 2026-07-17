import { useState } from "react"
import { Link } from "react-router-dom"
import { PixelArt } from "../components/PixelArt"

/**
 * UNDERWRITER CALCULATOR — a pure client-side expected-value model for
 * the /house pool. No contract wiring on purpose: this page answers one
 * question ("what does the pool clear per month?") before you deposit.
 */

function usd(n: number): string {
	// ASCII minus — the pixel faces don't ship a U+2212 glyph
	const rounded = Math.round(Math.abs(n))
	return `${n < 0 ? "-" : ""}$${rounded.toLocaleString()}`
}

/* ── one chunky lever ────────────────────────────────────────── */

function PxSlider({
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
				<span className="board-figure text-[26px]">{readout}</span>
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
			<span className="mt-1 flex justify-between font-body text-[12px] text-mute">
				<span>{min.toLocaleString()}</span>
				<span>{max.toLocaleString()}</span>
			</span>
		</label>
	)
}

/* ── page ────────────────────────────────────────────────────── */

export default function Calculator() {
	const [travelers, setTravelers] = useState(100)
	const [onTimePct, setOnTimePct] = useState(80)
	const [premium, setPremium] = useState(50)
	const [payout, setPayout] = useState(400)

	// Simplified expected-value model, computed live.
	const premiums = travelers * premium
	const payouts = travelers * (1 - onTimePct / 100) * payout
	const net = premiums - payouts
	const breakEven = (1 - premium / payout) * 100

	// break-even meter runs on the same 50–100% axis as the slider;
	// clamp a hair inside so the notches never get sliced by the border
	const meterPos = (v: number) =>
		`${Math.min(99, Math.max(1, ((v - 50) / 50) * 100))}%`
	const profitable = onTimePct >= breakEven

	return (
		<div className="mx-auto max-w-5xl space-y-8 px-4 py-8">
			<div>
				<Link
					to="/house"
					className="font-body text-[12px] font-semibold tracking-[0.08em] text-sky hover:text-ink"
				>
					◄ BACK TO EARN YIELD
				</Link>
				<h1 className="h-display mt-3 text-[22px] leading-[1.35] sm:text-[28px]">
					UNDERWRITER <span className="text-gold">CALCULATOR</span>
				</h1>
				<p className="mt-3 max-w-lg font-body text-[15px] leading-relaxed text-dim">
					Drag the levers. See what the pool clears in a month, and
					where the break-even line sits.
				</p>
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				{/* the levers */}
				<section className="panel space-y-7 p-5">
					<h2 className="h-section">THE LEVERS</h2>
					<PxSlider
						label="TRAVELERS BUYING / MONTH"
						value={travelers}
						min={0}
						max={1000}
						onChange={setTravelers}
						readout={travelers.toLocaleString()}
					/>
					<PxSlider
						label="% OF FLIGHTS ON TIME"
						value={onTimePct}
						min={50}
						max={100}
						onChange={setOnTimePct}
						readout={`${onTimePct}%`}
					/>
					<PxSlider
						label="PREMIUM PER POLICY"
						value={premium}
						min={10}
						max={100}
						onChange={setPremium}
						readout={`$${premium}`}
					/>
					<PxSlider
						label="PAYOUT IF DELAYED"
						value={payout}
						min={100}
						max={1000}
						step={10}
						onChange={setPayout}
						readout={`$${payout}`}
					/>
				</section>

				{/* the readout board */}
				<section className="relative border-2 border-line bg-inset p-5">
					<div className="scanlines pointer-events-none absolute inset-0" />
					<h2 className="h-section flex items-center gap-2">
						<PixelArt name="coin-usdc" icon className="h-6 w-6" />
						POOL READOUT — PER MONTH
					</h2>

					<div className="mt-5 space-y-3">
						<div className="flex items-baseline justify-between">
							<span className="label-px">PREMIUMS COLLECTED</span>
							<span className="font-board text-[28px] leading-none text-ink">
								{usd(premiums)}
							</span>
						</div>
						<div className="flex items-baseline justify-between">
							<span className="label-px">EXPECTED PAYOUTS</span>
							<span className="font-board text-[28px] leading-none text-loss">
								{usd(-payouts)}
							</span>
						</div>
						<div className="flex items-baseline justify-between border-t-2 border-dashed border-line-mid pt-3">
							<span className="label-px text-sky">
								NET FOR THE POOL
							</span>
							<span
								className={`font-display text-[22px] sm:text-[26px] ${
									net >= 0 ? "text-win" : "text-loss"
								}`}
							>
								{usd(net)}
							</span>
						</div>
						<p className="text-right font-body text-[13px] text-mute">
							{net >= 0
								? "the pool keeps the difference: that's the yield."
								: "at these terms the pool bleeds. Turn the levers."}
						</p>
					</div>

					{/* break-even instrument: on-time axis, 50 → 100% */}
					<div className="mt-6">
						<p className="label-px mb-2">BREAK-EVEN METER</p>
						<div className="relative h-7 border-2 border-line-mid bg-surface">
							{/* profitable zone: right of the break-even line */}
							<div
								className="absolute inset-y-0 right-0 bg-win/25"
								style={{
									left: meterPos(breakEven),
								}}
							/>
							{/* break-even notch */}
							<div
								className="absolute inset-y-0 w-[4px] -translate-x-1/2 bg-gold"
								style={{ left: meterPos(breakEven) }}
							/>
							{/* your on-time notch */}
							<div
								className="absolute inset-y-0 w-[4px] -translate-x-1/2 bg-ink"
								style={{ left: meterPos(onTimePct) }}
							/>
						</div>
						<div className="mt-1 flex justify-between font-body text-[12px] text-mute">
							<span>50%</span>
							<span>100% ON-TIME</span>
						</div>
						<p className="mt-3 font-body text-[13px] font-semibold tracking-[0.02em] text-gold">
							BREAK-EVEN: {breakEven.toFixed(1)}% ON-TIME
							<span
								className={`ml-2 ${profitable ? "text-win" : "text-loss"}`}
							>
								{profitable ? "▲ YOU CLEAR IT" : "▼ YOU'RE UNDER IT"}
							</span>
						</p>
						<p className="mt-2 font-body text-[14px] text-dim">
							US domestic average is ≈80%. Price accordingly.
						</p>
					</div>
				</section>
			</div>

			<p className="font-body text-[13px] text-mute">
				Simplified expected-value model. Not a promise of yield.
			</p>
		</div>
	)
}
