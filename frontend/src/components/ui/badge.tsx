import { type HTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const badgeVariants = cva(
	"inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold transition-colors",
	{
		variants: {
			variant: {
				default: "bg-primary/12 text-primary",
				pending: "bg-muted/60 text-muted-foreground",
				success: "bg-success/12 text-success",
				warning: "bg-warning/12 text-warning",
				destructive: "bg-destructive/12 text-destructive",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
)

export interface BadgeProps
	extends HTMLAttributes<HTMLSpanElement>,
		VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<span className={cn(badgeVariants({ variant, className }))} {...props} />
	)
}
