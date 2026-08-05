import { useState } from "react"

/**
 * A small "i" that explains a column, sitting in the table header.
 *
 * One per column, not one per row: the explanation is a property of the
 * COLUMN, so repeating it on all 1,069 rows is noise, and a hover target
 * on every cell makes the board twitchy to scan.
 *
 * Opens on hover and on keyboard focus, so it is reachable without a
 * mouse. The panel is `pointer-events-none` — it is a label, never
 * something to click into, and letting the cursor enter it would make it
 * flicker as the pointer crosses the gap.
 */
export function ColumnInfo({
	title,
	children,
}: {
	title: string
	children: React.ReactNode
}) {
	const [open, setOpen] = useState(false)
	return (
		<span
			className="column-info relative inline-flex align-middle"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			onFocus={() => setOpen(true)}
			onBlur={() => setOpen(false)}
			tabIndex={0}
			role="note"
			aria-label={`${title} — column explanation`}
		>
			<span
				aria-hidden="true"
				className="column-info-dot flex h-[14px] w-[14px] items-center justify-center border font-display text-[8px] leading-none"
			>
				i
			</span>
			{open && (
				<span className="info-panel panel-raised column-info-pop absolute top-full left-1/2 z-40 mt-2 block w-[21rem] max-w-[80vw] -translate-x-1/2 p-3 text-left normal-case">
					<span className="label-px mb-1.5 block text-gold">{title}</span>
					<span className="block font-body text-[12.5px] leading-relaxed tracking-normal text-dim">
						{children}
					</span>
				</span>
			)}
		</span>
	)
}
