import { useEffect, useRef, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router-dom"
import { useCopy } from "../copy"
import { REPO_URL } from "../config/links"

/**
 * First-visit agreement notice. A blocking, centered modal summarising the
 * service, eligibility, and risk terms; the app is usable only after the
 * visitor presses "Got it", which persists acceptance in localStorage.
 *
 * Deliberate differences from the Tour card:
 *  - failure to READ localStorage shows the notice (an agreement should
 *    fail toward being seen, where the tour fails toward silence);
 *  - no Escape/scrim dismissal — acceptance is the only way through.
 *
 * The linked legal pages open in a new tab so they are readable while the
 * gate is still up. Bump AGREEMENT_VERSION when the notice text changes
 * materially and every browser will be asked again.
 */

const STORAGE_KEY = "flightsfun_agreement"
const AGREEMENT_VERSION = "v1"

// Session-only fallback: if localStorage can't persist the acceptance,
// pressing "Got it" still dismisses the gate until the next full load.
let sessionAccepted = false

function accepted(): boolean {
	if (sessionAccepted) return true
	try {
		return localStorage.getItem(STORAGE_KEY) === AGREEMENT_VERSION
	} catch {
		return false
	}
}

// Acceptance is read by more than the gate (App hides the sticky chrome —
// activity log, tour card — until it's given), so it's a tiny subscribable
// store rather than gate-local state.
const listeners = new Set<() => void>()

function subscribeAccepted(cb: () => void): () => void {
	listeners.add(cb)
	return () => listeners.delete(cb)
}

/** Reactive "has this browser accepted the agreement notice?". */
export function useAgreementAccepted(): boolean {
	return useSyncExternalStore(subscribeAccepted, accepted)
}

function markAccepted() {
	sessionAccepted = true
	try {
		localStorage.setItem(STORAGE_KEY, AGREEMENT_VERSION)
	} catch {
		// Can't persist — the visitor will be asked again next load.
	}
	for (const cb of listeners) cb()
}

export function AgreementGate() {
	const t = useCopy()
	const { pathname } = useLocation()
	const isAccepted = useAgreementAccepted()
	// Only where money moves: the board and the vault. The legal pages the
	// notice links to (and every other route) stay readable without
	// accepting first; returning to a gated page unaccepted brings the
	// gate straight back. (/house lands here too — it redirects to /earn.)
	const GATED_PATHS = ["/", "/earn"]
	const show = !isAccepted && GATED_PATHS.includes(pathname)
	const panelRef = useRef<HTMLElement>(null)

	// Real modal behaviour while open: initial focus on the panel, Tab
	// trapped inside, and the page behind cannot scroll. No Escape handler
	// on purpose — the only exit is the accept button.
	useEffect(() => {
		if (!show) return
		panelRef.current?.focus()
		const prevOverflow = document.body.style.overflow
		document.body.style.overflow = "hidden"
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Tab") return
			const panel = panelRef.current
			if (!panel) return
			const focusables = panel.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
			)
			if (focusables.length === 0) return
			const first = focusables[0]
			const last = focusables[focusables.length - 1]
			const active = document.activeElement
			if (e.shiftKey && (active === first || active === panel)) {
				e.preventDefault()
				last.focus()
			} else if (!e.shiftKey && active === last) {
				e.preventDefault()
				first.focus()
			}
		}
		document.addEventListener("keydown", onKey)
		return () => {
			document.removeEventListener("keydown", onKey)
			document.body.style.overflow = prevOverflow
		}
	}, [show])

	if (!show) return null

	// markAccepted notifies the store, which re-renders this gate closed
	// and reveals the chrome App keeps hidden until acceptance.
	const accept = markAccepted

	// Internal legal pages open in a NEW TAB (plain <a>, not a router
	// Link): the gate blocks the app underneath, so navigating in place
	// would show a page the visitor cannot scroll or leave.
	const legalLinks: Array<{ href: string; label: string }> = [
		{ href: "/privacy", label: t.agreement.privacyLink },
		{ href: "/terms", label: t.agreement.termsLink },
		{ href: "/disclaimers", label: t.agreement.disclaimersLink },
	]

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			{/* scrim — intentionally not clickable */}
			<div aria-hidden="true" className="absolute inset-0 bg-page/90" />
			<section
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="agreement-title"
				data-testid="agreement-gate"
				tabIndex={-1}
				className="panel-raised relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col gap-4 overflow-y-auto p-6"
			>
				<div>
					<p className="label-px text-gold">{t.agreement.eyebrow}</p>
					<h2
						id="agreement-title"
						className="h-display mt-1 text-body text-ink"
					>
						{t.agreement.title}
					</h2>
				</div>

				<p className="font-body text-meta leading-relaxed text-dim">
					{t.agreement.intro}{" "}
					{legalLinks.map((l, i) => (
						<span key={l.href}>
							<a
								href={l.href}
								target="_blank"
								rel="noopener noreferrer"
								className="text-sky underline underline-offset-2 hover:text-ink"
							>
								{l.label}
							</a>
							{i < legalLinks.length - 1 ? " · " : ""}
						</span>
					))}
				</p>

				<div className="space-y-3">
					{t.agreement.sections.map((s) => (
						<section key={s.heading}>
							<h3 className="label-px mb-1">{s.heading}</h3>
							<p className="font-body text-meta leading-relaxed text-dim">
								{s.body}
							</p>
						</section>
					))}
				</div>

				<div className="panel-inset p-3">
					<p className="font-body text-meta leading-relaxed text-ink">
						{t.agreement.representation}
					</p>
				</div>

				<p className="font-body text-fine leading-relaxed text-mute">
					{t.agreement.draftNote}{" "}
					<a
						href={`${REPO_URL}/issues`}
						target="_blank"
						rel="noopener noreferrer"
						className="text-sky underline underline-offset-2 hover:text-ink"
					>
						{t.agreement.issuesLink}
					</a>
					.
				</p>

				<button
					type="button"
					data-testid="agreement-accept"
					className="btn-px btn-gold w-full"
					onClick={accept}
				>
					{t.agreement.accept}
				</button>
			</section>
		</div>,
		document.body,
	)
}
