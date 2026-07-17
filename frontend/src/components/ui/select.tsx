import { forwardRef, type SelectHTMLAttributes } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "../../lib/utils"

const Select = forwardRef<
	HTMLSelectElement,
	SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
	<div className="relative">
		<select
			ref={ref}
			className={cn(
				"h-11 w-full appearance-none border border-input bg-background/60 px-3.5 py-2 pr-10 rounded-lg text-sm text-foreground focus:ring-2 focus:ring-ring/40 focus:ring-offset-1 focus:outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
		</select>
		<ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
	</div>
))
Select.displayName = "Select"

export { Select }
