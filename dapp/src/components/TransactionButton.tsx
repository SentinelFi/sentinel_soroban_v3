import type { TxState } from "../types"
import { cn } from "../lib/utils"

const STATE_LABEL: Partial<Record<TxState, string>> = {
	verifying: "VERIFYING…",
	awaiting: "CHECK WALLET…",
	confirming: "CONFIRMING…",
	success: "✓ DONE",
	error: "FAILED — RETRY",
}

/**
 * Pixel button wrapping the standard write-tx lifecycle
 * (idle → awaiting → confirming → success | error).
 */
export function TransactionButton({
	state,
	onClick,
	disabled,
	className,
	title,
	children,
}: {
	state: TxState
	onClick: () => void
	disabled?: boolean
	className?: string
	/** Why the button is disabled — surfaced as a tooltip while it is. */
	title?: string
	children: React.ReactNode
}) {
	const busy = state === "verifying" || state === "awaiting" || state === "confirming"
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled || busy}
			title={disabled && !busy ? title : undefined}
			className={cn("btn-px", className)}
		>
			{STATE_LABEL[state] ?? children}
		</button>
	)
}
