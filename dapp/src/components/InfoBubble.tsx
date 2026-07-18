import { useEffect, useRef, useState } from "react"
import { useCopy } from "../copy"

/**
 * Info bubble: a bordered "?" control that toggles a small bordered panel.
 * The panel is mounted/unmounted on toggle — never opacity-gated — so its
 * content is fully visible whenever it exists. Fun keeps the pixel square;
 * the serious skin rounds it via the `.info-bubble` class overrides.
 */
export function InfoBubble({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLSpanElement>(null)
	const t = useCopy()

	// close on outside click / Escape
	useEffect(() => {
		if (!open) return
		const onPointer = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false)
		}
		document.addEventListener("mousedown", onPointer)
		document.addEventListener("keydown", onKey)
		return () => {
			document.removeEventListener("mousedown", onPointer)
			document.removeEventListener("keydown", onKey)
		}
	}, [open])

	return (
		<span ref={rootRef} className="relative inline-flex">
			<button
				type="button"
				aria-expanded={open}
				aria-label={t.info.aria}
				title={t.info.aria}
				onClick={() => setOpen((o) => !o)}
				className={`info-bubble flex h-6 w-6 items-center justify-center border-2 font-display text-[10px] leading-none transition-none ${
					open
						? "border-gold bg-gold text-page"
						: "border-line-strong bg-inset text-sky hover:border-gold hover:text-gold"
				}`}
			>
				?
			</button>
			{open && (
				<div
					role="note"
					className="info-panel panel-raised absolute left-1/2 top-full z-30 mt-2 w-[19rem] max-w-[80vw] -translate-x-1/2 p-4 text-left normal-case tracking-normal sm:w-[21rem]"
				>
					<p className="label-px mb-2 text-gold">{t.info.title}</p>
					<p className="font-body text-[13px] leading-relaxed text-dim">
						{children}
					</p>
				</div>
			)}
		</span>
	)
}

/** Shared copy for the Markets board and the Earn Yield page. */
export function HowItWorksBubble() {
	return (
		<InfoBubble>
			This is parametric insurance played as a prediction market.
			Travelers buy cover on their own flight (a bet on{" "}
			<span className="font-semibold text-loss">DELAYED</span>).
			Underwriters take the other side and earn premiums when flights
			land <span className="font-semibold text-win">on time</span>. No
			claims forms: an oracle settles every flight on-chain.
		</InfoBubble>
	)
}
