import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useCopy } from "../copy"
import { FREIGHTER_URL, STELLAR_URL } from "../config/links"

/**
 * First-visit onboarding. A small card docks bottom-right on the home page
 * offering a guided lap around the app; declining, finishing, or leaving
 * the tour writes a localStorage flag so this browser never sees it again.
 * While touring, the card walks STEPS in order — navigating to each page
 * and outlining its `data-tour` anchor (see .tour-highlight in index.css).
 */

const STORAGE_KEY = "flightsfun_tour"

const STEPS = [
	{ path: "/", target: "nav" },
	{ path: "/", target: "board" },
	{ path: "/markets", target: "live" },
	{ path: "/policies", target: "policies" },
	{ path: "/house", target: "house" },
	{ path: "/calculator", target: "calc" },
] as const

function seen(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== null
	} catch {
		// can't persist a dismissal — never show rather than nag every load
		return true
	}
}

function markSeen() {
	try {
		localStorage.setItem(STORAGE_KEY, "done")
	} catch {
		// ignore persistence failure
	}
}

export function Tour() {
	const t = useCopy()
	const navigate = useNavigate()
	const { pathname } = useLocation()
	const [stage, setStage] = useState<"welcome" | "steps" | "hidden">(() =>
		seen() ? "hidden" : "welcome",
	)
	const [step, setStep] = useState(0)
	// false while the step's page (and its data-tour anchor) is still
	// loading — the card shows a loading line instead of the step text, so
	// the text never describes a page that isn't on screen yet. Step
	// handlers reset it; the anchor effect below flips it back on.
	const [ready, setReady] = useState(false)
	const cardRef = useRef<HTMLElement>(null)

	const close = useCallback(() => {
		markSeen()
		setStage("hidden")
	}, [])

	const goToStep = useCallback((next: number) => {
		setReady(false)
		setStep(next)
	}, [])

	// While touring: make sure we're on the step's page, then outline its
	// anchor. Lazy pages mount their chunk after navigation, so poll briefly
	// for the anchor instead of assuming it exists. Layout effect + an
	// immediate first attempt: same-page steps resolve before paint, so
	// only genuine page loads ever show the loading line.
	useLayoutEffect(() => {
		if (stage !== "steps") return
		const { path, target } = STEPS[step]
		if (pathname !== path) {
			navigate(path)
			return // effect re-runs once the location updates
		}
		let el: HTMLElement | null = null
		let tries = 0
		let timer: number | undefined
		const attempt = () => {
			el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`)
			if (el) {
				if (timer !== undefined) clearInterval(timer)
				el.classList.add("tour-highlight")
				// tall anchors (whole-page columns) read better pinned to the
				// top of the viewport than centered on their midpoint
				el.scrollIntoView({
					block:
						el.offsetHeight > window.innerHeight * 0.7
							? "start"
							: "center",
				})
				setReady(true)
			} else if (++tries > 40) {
				// anchor never appeared (chunk failed?) — show the text
				// rather than a loading line forever
				if (timer !== undefined) clearInterval(timer)
				setReady(true)
			}
		}
		attempt()
		if (!el) timer = window.setInterval(attempt, 100)
		return () => {
			if (timer !== undefined) clearInterval(timer)
			el?.classList.remove("tour-highlight")
		}
	}, [stage, step, pathname, navigate])

	// Escape bails out of both the welcome card and a running tour.
	useEffect(() => {
		if (stage === "hidden") return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [stage, close])

	// Keep keyboard users on the card as it hops between pages.
	useEffect(() => {
		if (stage === "steps") cardRef.current?.focus({ preventScroll: true })
	}, [stage, step])

	if (stage === "hidden") return null
	// the invite only belongs on the landing page; a running tour follows
	// the visitor everywhere
	if (stage === "welcome" && pathname !== "/") return null

	if (stage === "welcome") {
		return (
			<aside
				className="tour-dock panel-raised"
				role="dialog"
				aria-label={t.tour.welcomeTitle}
			>
				<p className="font-display text-[11px] leading-[1.6] text-gold">
					{t.tour.welcomeTitle}
				</p>
				<p className="mt-2 font-body text-[13px] leading-relaxed text-dim">
					{t.tour.welcomeBody}
				</p>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<button
						type="button"
						onClick={() => {
							goToStep(0)
							setStage("steps")
						}}
						className="btn-px btn-gold btn-sm"
					>
						{t.tour.start}
					</button>
					<button
						type="button"
						onClick={close}
						className="btn-px btn-ghost btn-sm"
					>
						{t.tour.dismiss}
					</button>
				</div>
			</aside>
		)
	}

	const { target } = STEPS[step]
	const s = t.tour.steps[target]
	const last = step === STEPS.length - 1
	return (
		<aside
			ref={cardRef}
			tabIndex={-1}
			className="tour-dock panel-raised"
			role="dialog"
			aria-label={t.tour.stepLabel(step + 1, STEPS.length)}
		>
			<div className="flex items-center justify-between gap-3">
				<span className="label-px text-sky">
					{t.tour.stepLabel(step + 1, STEPS.length)}
				</span>
				<button
					type="button"
					onClick={close}
					aria-label={t.tour.skipAria}
					className="font-body text-[13px] font-bold text-mute hover:text-ink"
				>
					✕
				</button>
			</div>
			{ready ? (
				<>
					<p className="mt-2 font-display text-[11px] leading-[1.6] text-gold">
						{s.title}
					</p>
					<p className="mt-2 font-body text-[13px] leading-relaxed text-dim">
						{s.body}
					</p>
					{target === "nav" && (
						<p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-body text-[12px] font-semibold">
							<a
								href={FREIGHTER_URL}
								target="_blank"
								rel="noopener noreferrer"
								className="footer-link"
							>
								{t.tour.walletLink}
							</a>
							<a
								href={STELLAR_URL}
								target="_blank"
								rel="noopener noreferrer"
								className="footer-link"
							>
								{t.tour.stellarLink}
							</a>
						</p>
					)}
				</>
			) : (
				<p
					aria-live="polite"
					className="mt-2 font-body text-[13px] leading-relaxed text-mute"
				>
					{t.tour.loading}
				</p>
			)}
			<div className="mt-3 flex items-center justify-between gap-2">
				<button
					type="button"
					onClick={() => goToStep(Math.max(0, step - 1))}
					disabled={step === 0 || !ready}
					className="btn-px btn-ghost btn-sm disabled:opacity-40"
				>
					{t.tour.back}
				</button>
				<button
					type="button"
					onClick={() => {
						if (last) {
							// the tour ends where it began — back on the board
							close()
							navigate("/")
						} else {
							goToStep(step + 1)
						}
					}}
					disabled={!ready}
					className="btn-px btn-gold btn-sm disabled:opacity-40"
				>
					{last ? t.tour.done : t.tour.next}
				</button>
			</div>
		</aside>
	)
}
