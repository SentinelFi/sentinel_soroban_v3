import { Loader2, Check } from "lucide-react"
import { cn } from "../lib/utils"
import type { TxState } from "../types"

interface TransactionButtonProps {
	state: TxState
	onClick: () => void
	disabled?: boolean
	children: React.ReactNode
	className?: string
}

export function TransactionButton({
	state,
	onClick,
	disabled,
	children,
	className,
}: TransactionButtonProps) {
	const isLoading = state === "awaiting" || state === "confirming"

	return (
		<button
			onClick={onClick}
			disabled={disabled || isLoading}
			className={cn(
				"w-full h-11 font-semibold tracking-wide transition-all duration-300 rounded-lg text-sm disabled:cursor-not-allowed disabled:opacity-50",
				state === "idle" &&
					"shimmer-cta text-primary-foreground",
				state === "awaiting" &&
					"bg-primary/80 text-primary-foreground",
				state === "confirming" &&
					"bg-primary/80 text-primary-foreground",
				state === "success" &&
					"bg-success/15 text-success border border-success/25 shadow-[0_0_20px_rgba(14,200,100,0.08)]",
				state === "error" &&
					"bg-destructive/15 text-destructive border border-destructive/25",
				className,
			)}
		>
			{isLoading ? (
				<span className="inline-flex items-center gap-2">
					<Loader2 className="h-4 w-4 animate-spin" />
					{state === "awaiting" ? "Awaiting Signature..." : "Confirming..."}
				</span>
			) : state === "success" ? (
				<span className="inline-flex items-center gap-2">
					<Check className="h-4 w-4" />
					Success
				</span>
			) : (
				children
			)}
		</button>
	)
}
