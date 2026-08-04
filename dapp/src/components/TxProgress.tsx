import { useEffect, useState } from "react"
import { Radar, Wallet, Loader2, CheckCircle2, XCircle } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useTheme } from "../providers/ThemeProvider"
import { PixelArt } from "./PixelArt"
import type { TxState } from "../types"

/**
 * Shared tx-lifecycle stepper — replaces the plain button-label states
 * (CHECK WALLET… / CONFIRMING…) with a real staged progress view. Each
 * flow declares which of the three await stages it actually has
 * (`steps`); flows with no JIT check (claim/deposit/withdraw/admin runs)
 * just omit "verifying".
 *
 * Two genuinely different renders, not one re-skinned:
 *   fun     — boarding-pass runway: radar sweep while verifying, the
 *             plane taxis stage to stage, a COVERED/DENIED/PAID stamp
 *             drops on the terminal state, confetti on success.
 *   serious — a 3-dot stepper, a status line, and a live elapsed counter.
 *
 * Renders nothing at `idle` — callers keep it mounted next to their
 * existing button; it only appears once a flow actually starts, and
 * never blocks the rest of the page.
 */

export type TxStepKey = "verifying" | "awaiting" | "confirming"

const STEP_LABEL: Record<TxStepKey, { fun: string; serious: string }> = {
	verifying: { fun: "VERIFY", serious: "Verify" },
	awaiting: { fun: "SIGN", serious: "Sign" },
	confirming: { fun: "CONFIRM", serious: "Confirm" },
}

const STEP_ICON: Record<TxStepKey, LucideIcon> = {
	verifying: Radar,
	awaiting: Wallet,
	confirming: Loader2,
}

export interface TxProgressStamps {
	/** PixelArt asset name shown (fun theme only) when the flow succeeds. */
	success: "stamp-covered" | "stamp-paid"
	/** PixelArt asset name shown (fun theme only) on failure. Defaults to stamp-denied. */
	fail?: "stamp-denied"
}

export function TxProgress({
	state,
	steps,
	error,
	stamps,
	errorTestId,
}: {
	state: TxState
	steps: readonly TxStepKey[]
	error?: string | null
	stamps?: TxProgressStamps
	/** Inert automation hook — stamped on the error text element while failed. */
	errorTestId?: string
}) {
	const { theme } = useTheme()
	const active = state === "verifying" || state === "awaiting" || state === "confirming"
	const [elapsedMs, setElapsedMs] = useState(0)

	useEffect(() => {
		if (!active) {
			setElapsedMs(0)
			return
		}
		const startedAt = Date.now()
		const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 100)
		return () => clearInterval(id)
	}, [active])

	if (state === "idle") return null

	const stepIndex = steps.indexOf(state as TxStepKey)

	return theme === "serious" ? (
		<SeriousStepper state={state} steps={steps} stepIndex={stepIndex} error={error} elapsedMs={elapsedMs} errorTestId={errorTestId} />
	) : (
		<FunStepper state={state} steps={steps} stepIndex={stepIndex} error={error} stamps={stamps} errorTestId={errorTestId} />
	)
}

function statusLine(state: TxState, steps: readonly TxStepKey[], stepIndex: number, error?: string | null): string {
	if (state === "success") return "Done"
	if (state === "error") return error ?? "Failed"
	const key = steps[stepIndex] as TxStepKey | undefined
	return key ? `${STEP_LABEL[key].serious}…` : ""
}

function SeriousStepper({
	state,
	steps,
	stepIndex,
	error,
	elapsedMs,
	errorTestId,
}: {
	state: TxState
	steps: readonly TxStepKey[]
	stepIndex: number
	error?: string | null
	elapsedMs: number
	errorTestId?: string
}) {
	const failed = state === "error"
	const done = state === "success"
	return (
		<div className="tx-progress tx-progress-serious" role="status" aria-live="polite">
			<div className="flex items-center">
				{steps.map((step, i) => {
					const Icon = STEP_ICON[step]
					const isDone = done || i < stepIndex
					const isActive = !done && !failed && i === stepIndex
					return (
						<div key={step} className="flex items-center">
							<span
								className={`tx-dot ${isDone ? "is-done" : isActive ? "is-active" : ""} ${failed && i === stepIndex ? "is-failed" : ""}`}
							>
								{failed && i === stepIndex ? (
									<XCircle className="h-3.5 w-3.5" />
								) : isDone ? (
									<CheckCircle2 className="h-3.5 w-3.5" />
								) : (
									<Icon className="h-3 w-3" />
								)}
							</span>
							{i < steps.length - 1 && (
								<span className={`tx-dot-line ${isDone ? "is-done" : ""}`} />
							)}
						</div>
					)
				})}
			</div>
			<p
				data-testid={failed ? errorTestId : undefined}
				className={`mt-2 font-body text-[13px] ${failed ? "text-loss" : "text-dim"}`}
			>
				{statusLine(state, steps, stepIndex, error)}
			</p>
			{!done && !failed && (
				<p className="font-body text-[11px] text-mute">{(elapsedMs / 1000).toFixed(1)}s</p>
			)}
		</div>
	)
}

function FunStepper({
	state,
	steps,
	stepIndex,
	error,
	stamps,
	errorTestId,
}: {
	state: TxState
	steps: readonly TxStepKey[]
	stepIndex: number
	error?: string | null
	stamps?: TxProgressStamps
	errorTestId?: string
}) {
	const done = state === "success"
	const failed = state === "error"
	const progress = done || failed ? 1 : steps.length > 1 ? stepIndex / (steps.length - 1) : stepIndex >= 0 ? 1 : 0

	return (
		<div className="tx-progress tx-progress-fun" role="status" aria-live="polite">
			{!done && !failed && (
				<div className="tx-runway">
					<div className="tx-runway-strip" />
					<div className="tx-runway-plane" style={{ left: `${progress * 100}%` }}>
						<PixelArt name="betslip-plane" className="h-6 w-10" />
					</div>
					{state === "verifying" && (
						<PixelArt name="radar-sweep" className="tx-radar h-7 w-7" />
					)}
				</div>
			)}
			{(done || failed) && (
				<div className="tx-stamp-pop">
					{stamps ? (
						<PixelArt
							name={failed ? (stamps.fail ?? "stamp-denied") : stamps.success}
							className="h-12 w-24"
						/>
					) : (
						// No flow-specific stamp (deposit/withdraw/admin runs) — a plain
						// glyph badge rather than presuming COVERED/DENIED apply here.
						<span
							className={`font-board text-[28px] ${failed ? "text-loss" : "text-win"}`}
						>
							{failed ? "✕" : "✓"}
						</span>
					)}
					{done && <Confetti />}
				</div>
			)}
			<p
				data-testid={failed ? errorTestId : undefined}
				className={`label-px mt-1.5 ${failed ? "text-loss" : "text-mute"}`}
			>
				{done
					? "DONE"
					: failed
						? (error ?? "FAILED").toUpperCase()
						: (STEP_LABEL[steps[stepIndex] as TxStepKey]?.fun ?? "")}
			</p>
		</div>
	)
}

function Confetti() {
	return (
		<div className="tx-confetti" aria-hidden="true">
			{Array.from({ length: 14 }, (_, i) => (
				<span key={i} className="tx-confetti-piece" style={{ "--i": i } as React.CSSProperties} />
			))}
		</div>
	)
}
