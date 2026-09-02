import { useEffect, useRef, useState } from "react"
import {
	useDepositQueue,
	useFlightDataBatch,
	usePolicyStateBatch,
	useTravelerFlights,
	useWithdrawalQueue,
	formatUsdc,
} from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import { notificationPermission, showAlert } from "../lib/claimReminders"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"

/**
 * In-app event alerts, both roles:
 *   traveler    — flight delayed / cancelled, policy settled on time,
 *                 payout ready to claim;
 *   underwriter — deposit processed (shares minted), withdrawal
 *                 processed (USDC collectable).
 *
 * A null-rendering watcher diffs the connected wallet's chain state
 * against a per-address baseline in localStorage and fires an OS
 * notification per observed TRANSITION — never for pre-existing state,
 * so connecting an old wallet doesn't replay history. Works from any
 * page while a dapp tab is open; closed-tab delivery would need
 * backend web push and is deliberately out of scope.
 *
 * Permission is requested only from the AlertsPrompt card below, which
 * appears once, after the user's FIRST successful transaction — the
 * moment they acquire a stake worth being alerted about. No load-time
 * permission prompt, ever.
 */

const PROMPTED_KEY = "flightsfun_alerts_prompted"
const BASELINE_KEY = "flightsfun_alert_state"

/** Policy lifecycle phase, ordered; a notification fires on advancement. */
type Phase = "active" | "delayed" | "cancelled" | "payout" | "ontime" | "done"

interface Baseline {
	policies: Record<string, Phase>
	deposits: string[]
	withdrawals: string[]
}

function loadBaseline(address: string): Baseline | null {
	try {
		const raw = localStorage.getItem(`${BASELINE_KEY}:${address}`)
		return raw ? (JSON.parse(raw) as Baseline) : null
	} catch {
		return null
	}
}

function saveBaseline(address: string, b: Baseline): void {
	try {
		localStorage.setItem(`${BASELINE_KEY}:${address}`, JSON.stringify(b))
	} catch {
		/* per-session memory still prevents repeats via the ref below */
	}
}

export function EventAlerts() {
	const t = useCopy()
	const { address } = useWallet()
	const { data: flights } = useTravelerFlights(address)
	const { data: states } = usePolicyStateBatch(flights, address)
	const { data: flightData } = useFlightDataBatch(flights)
	const { data: depQueue } = useDepositQueue()
	const { data: wdQueue } = useWithdrawalQueue()

	// A queue entry vanishing right after OUR OWN transaction is almost
	// certainly the user cancelling it from the Earn page — don't
	// congratulate them on a "processed" deposit they just withdrew.
	const lastTxAt = useRef(0)
	useEffect(() => {
		const onTx = () => {
			lastTxAt.current = Date.now()
		}
		window.addEventListener("flightsfun:tx-success", onTx)
		return () => window.removeEventListener("flightsfun:tx-success", onTx)
	}, [])

	useEffect(() => {
		if (!address || !states || !flightData) return
		const nowSecs = Math.floor(Date.now() / 1000)

		const oracleByKey = new Map(
			flightData.map((e) => [`${e.flightId}:${e.date.toString()}`, e.data]),
		)

		const phases: Record<string, Phase> = {}
		const details: Record<string, { flightId: string; payoff?: bigint }> = {}
		for (const s of states) {
			const id = `${s.flightId}-${s.date.toString()}`
			const settle = s.config?.status.tag
			const oracle = oracleByKey.get(`${s.flightId}:${s.date.toString()}`)?.status.tag
			let phase: Phase = "active"
			if (settle === "SettledOnTime") phase = "ontime"
			else if (settle === "SettledDelayed" || settle === "SettledCancelled") {
				const open =
					s.config != null && nowSecs < Number(s.config.claim_expiry)
				phase = s.claimed || !open ? "done" : "payout"
			} else if (oracle === "ToBeSettledDelayed") phase = "delayed"
			else if (oracle === "Cancelled" || oracle === "ToBeSettledCancelled")
				phase = "cancelled"
			phases[id] = phase
			details[id] = { flightId: s.flightId, payoff: s.config?.payoff }
		}

		const myDeposits = (depQueue ?? [])
			.filter((r) => r.owner === address)
			.map((r) => r.request_id.toString())
		const myWithdrawals = (wdQueue ?? [])
			.filter((r) => r.owner === address)
			.map((r) => r.request_id.toString())

		const prev = loadBaseline(address)
		// First sight of this address: record silently — transitions only.
		if (prev !== null) {
			const RANK: Record<Phase, number> = {
				active: 0,
				delayed: 1,
				cancelled: 1,
				ontime: 2,
				payout: 2,
				done: 3,
			}
			for (const [id, phase] of Object.entries(phases)) {
				const before = prev.policies[id] ?? "active"
				if (RANK[phase] <= RANK[before] || phase === "done") continue
				const d = details[id]
				if (!d) continue
				if (phase === "delayed")
					showAlert(t.alerts.delayed(d.flightId), t.alerts.delayedBody, `evt-${id}-delayed`)
				else if (phase === "cancelled")
					showAlert(t.alerts.cancelledFlight(d.flightId), t.alerts.cancelledBody, `evt-${id}-cancelled`)
				else if (phase === "ontime")
					showAlert(t.alerts.settledOnTime(d.flightId), t.alerts.settledOnTimeBody, `evt-${id}-ontime`)
				else if (phase === "payout")
					showAlert(
						t.alerts.payoutReady(d.payoff !== undefined ? formatUsdc(d.payoff) : "—"),
						t.alerts.payoutReadyBody(d.flightId),
						`evt-${id}-payout`,
					)
			}

			const selfAction = Date.now() - lastTxAt.current < 90_000
			// Diff only when this poll actually returned queue data — a
			// failed queue read must not read as "everything processed".
			if (depQueue && !selfAction) {
				for (const gone of prev.deposits.filter((r) => !myDeposits.includes(r)))
					showAlert(t.alerts.depositProcessed, t.alerts.depositProcessedBody, `evt-dep-${gone}`)
			}
			if (wdQueue && !selfAction) {
				for (const gone of prev.withdrawals.filter((r) => !myWithdrawals.includes(r)))
					showAlert(t.alerts.withdrawalProcessed, t.alerts.withdrawalProcessedBody, `evt-wd-${gone}`)
			}
		}

		saveBaseline(address, {
			policies: phases,
			deposits: depQueue ? myDeposits : (prev?.deposits ?? []),
			withdrawals: wdQueue ? myWithdrawals : (prev?.withdrawals ?? []),
		})
	}, [address, states, flightData, depQueue, wdQueue, t])

	return null
}

const LATER_KEY = "flightsfun_alerts_later"

/**
 * Permission card, shown after a successful transaction (any signing
 * flow — buy, claim, deposit, withdraw) as a centered modal over a
 * faded page. "Enable" runs the browser permission prompt from the
 * button's own user gesture; "Not now" (and Escape) snoozes it for
 * this session — the next session's first transaction re-offers;
 * "Don't ask again" hides it forever (the Policies page's "remind me"
 * button remains as the manual path back in).
 */
export function AlertsPrompt() {
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const { addNotification } = useNotification()
	const [show, setShow] = useState(false)
	const panelRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const onTx = () => {
			try {
				if (localStorage.getItem(PROMPTED_KEY)) return
				if (sessionStorage.getItem(LATER_KEY)) return
			} catch {
				/* can't check → still offer once this page load */
			}
			if (notificationPermission() !== "default") return
			setShow(true)
		}
		window.addEventListener("flightsfun:tx-success", onTx)
		return () => window.removeEventListener("flightsfun:tx-success", onTx)
	}, [])

	// Modal manners while shown: take focus, close ("not now") on Escape.
	useEffect(() => {
		if (!show) return
		panelRef.current?.focus()
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") notNow()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [show])

	if (!show) return null

	const notNow = () => {
		try {
			sessionStorage.setItem(LATER_KEY, "1")
		} catch {
			/* page-load-only snooze */
		}
		setShow(false)
	}

	const never = () => {
		try {
			localStorage.setItem(PROMPTED_KEY, "1")
		} catch {
			/* session-only dismissal */
		}
		setShow(false)
	}

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center p-4">
			{/* faded page behind the card — intentionally not clickable */}
			<div aria-hidden="true" className="absolute inset-0 bg-page/80" />
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label={t.alerts.promptTitle}
				data-testid="alerts-prompt"
				tabIndex={-1}
				className="panel-raised relative z-10 w-full max-w-sm p-5"
			>
				<h2 className={`h-display ${serious ? "text-[20px]" : "text-[15px]"} text-gold`}>
					{t.alerts.promptTitle}
				</h2>
				<p className="mt-2 font-body text-meta leading-relaxed text-dim">
					{t.alerts.promptBody}
				</p>
				<div className="mt-4 flex flex-wrap items-center gap-2">
					<button
						type="button"
						data-testid="alerts-enable"
						className="btn-px btn-gold btn-sm"
						onClick={() => {
							void Notification.requestPermission().then((p) => {
								if (p === "granted")
									addNotification(t.alerts.enabledToast, "success")
							})
							never()
						}}
					>
						{t.alerts.promptEnable}
					</button>
					<button
						type="button"
						data-testid="alerts-dismiss"
						className="btn-px btn-ghost btn-sm"
						onClick={notNow}
					>
						{t.alerts.promptDismiss}
					</button>
					<button
						type="button"
						data-testid="alerts-never"
						className="btn-px btn-ghost btn-sm"
						onClick={never}
					>
						{t.alerts.promptNever}
					</button>
				</div>
			</div>
		</div>
	)
}
