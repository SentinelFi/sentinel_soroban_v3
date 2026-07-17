import { cn } from "../lib/utils"

export function SampleDataNotice({
	className,
	children,
}: {
	className?: string
	children?: React.ReactNode
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-lg border border-highlight/20 bg-highlight/5 px-3 py-2 text-xs text-highlight",
				className,
			)}
		>
			<span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-highlight animate-pulse" />
			{children ?? "Displaying sample data — connect to testnet for live results"}
		</div>
	)
}
