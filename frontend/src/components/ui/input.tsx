import { forwardRef, type InputHTMLAttributes } from "react"
import { cn } from "../../lib/utils"

const Input = forwardRef<
	HTMLInputElement,
	InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
	<input
		type={type}
		className={cn(
			"h-11 w-full border border-input bg-background/60 px-3.5 py-2 rounded-lg text-sm placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/40 focus:ring-offset-1 focus:outline-none transition-all duration-200",
			className,
		)}
		ref={ref}
		{...props}
	/>
))
Input.displayName = "Input"

export { Input }
